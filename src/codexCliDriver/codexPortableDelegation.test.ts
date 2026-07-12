import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";

import { type CaaraAgentApi, runCaaraAgentStart, runCaaraAgentWait } from "../caaraAgentCli.ts";
import { CaaraSettings, defaultCaaraSettingsValue } from "../caaraSettings.ts";
import { AgentDriverRegistry } from "../mockResponsesProvider/agentDriver.ts";
import { RelayLogger } from "../mockResponsesProvider/relayLogger.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { portableAgentRoutesLayerFromTurns } from "../portableAgentHttp.ts";
import { portableAgentTurnsLive } from "../portableAgentTurn.ts";
import {
  type CodexCliClient,
  type CodexCliInvocation,
  createCodexCliAgentDriver,
} from "./driver.ts";

/** Stable workspace passed through the public portable working-directory contract. */
const projectRoot = process.cwd();

/** Returns the private reasoning marker available only through the human viewer. */
const reasoningSentinel = (): string => "CODEX_PRIVATE_REASONING_SENTINEL";

/** Returns the terminal answer exposed through the agent-safe wait projection. */
const finalAnswer = (): string => "CODEX_PORTABLE_FINAL_ANSWER";

/** Real HTTP adapter matching the public CLI's service boundary. */
const makeTestServerApi = ({
  client,
}: {
  readonly client: typeof HttpClient.HttpClient.Service;
}): CaaraAgentApi => {
  const execute = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
    const response = yield* client.execute(request);
    return { status: response.status, body: yield* response.json };
  });
  return {
    post: ({ url, body }) =>
      HttpClientRequest.bodyJson(HttpClientRequest.post(new URL(url).pathname), body).pipe(
        Effect.flatMap(execute),
        Effect.orDie,
      ),
    get: (url) =>
      execute(HttpClientRequest.get(`${new URL(url).pathname}${new URL(url).search}`)).pipe(
        Effect.orDie,
      ),
  };
};

/** Builds a controllable Codex client and retains each driver invocation for resume assertions. */
const makeCodexClient = (): {
  readonly client: CodexCliClient;
  readonly invocations: CodexCliInvocation[];
} => {
  const invocations: CodexCliInvocation[] = [];
  const client: CodexCliClient = {
    start: (invocation) =>
      Effect.sync(() => invocations.push(invocation)).pipe(
        Effect.map(() => ({
          sessionId: `codex-thread-${String(invocations.length)}`,
          runtimeEvents: Stream.fromIterable([
            { _tag: "Reasoning", text: reasoningSentinel() } as const,
            { _tag: "Assistant", text: finalAnswer() } as const,
            { _tag: "Succeeded" } as const,
          ]),
          cancel: Effect.succeed({ _tag: "Terminated", sessionReusable: false } as const),
        })),
      ),
  };
  return { client, invocations };
};

/** Builds portable HTTP routes backed by the real Codex driver and injected process seam. */
const portableCodexLayer = ({ client }: { readonly client: CodexCliClient }) => {
  const routes = portableAgentRoutesLayerFromTurns({ turnsLayer: portableAgentTurnsLive });
  const server = Layer.effectDiscard(
    Effect.gen(function* () {
      const app = yield* HttpRouter.toHttpEffect(routes);
      yield* HttpServer.serveEffect(app);
    }),
  );
  const driver = createCodexCliAgentDriver({ client, maximumDepth: 3 });
  return server.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(
      sessionDirectoryBunTestLayer({
        stateDir: path.join(
          projectRoot,
          "temp.local",
          "2026-07-12",
          `codex-portable-${randomUUID()}`,
        ),
      }),
    ),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(Layer.succeed(RelayLogger, { log: () => Effect.void })),
    Layer.provideMerge(Layer.succeed(CaaraSettings, defaultCaaraSettingsValue)),
    Layer.provideMerge(
      Layer.succeed(AgentDriverRegistry, { resolve: () => Effect.succeed(driver) }),
    ),
  );
};

/** Starts one Codex turn through CLI adaptation and the real portable HTTP router. */
const startCodexTurn = ({
  api,
  prompt,
  sessionId,
}: {
  readonly api: CaaraAgentApi;
  readonly prompt: string;
  readonly sessionId?: string;
}) =>
  runCaaraAgentStart({
    args: ["--host", "127.0.0.1", "--port", "8787"],
    prompt,
    target: "codex/gpt-5.6-codex",
    cwd: projectRoot,
    driverOptions: {},
    sessionId,
    api,
  });

/** Proves public CLI/HTTP projection, human observation, and durable Codex resume behavior. */
const provePortableDelegation = Effect.fnUntraced(function* ({
  fixture,
}: {
  readonly fixture: ReturnType<typeof makeCodexClient>;
}) {
  const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
  const first = yield* startCodexTurn({ api, prompt: "first portable Codex prompt" });
  const firstWait = yield* runCaaraAgentWait({
    args: [],
    turnId: first.turnId,
    timeoutMillis: 250,
    api,
  });
  const firstViewer = yield* HttpClient.execute(
    HttpClientRequest.get(new URL(first.observationUrl).pathname),
  ).pipe(Effect.flatMap((response) => response.text));
  const resumed = yield* startCodexTurn({
    api,
    prompt: "resumed portable Codex prompt",
    sessionId: first.sessionId,
  });
  const resumedWait = yield* runCaaraAgentWait({
    args: [],
    turnId: resumed.turnId,
    timeoutMillis: 250,
    api,
  });

  assert.deepStrictEqual(firstWait, {
    schemaVersion: 1,
    status: "completed",
    finalAnswer: finalAnswer(),
  });
  assert.deepStrictEqual(resumedWait, {
    schemaVersion: 1,
    status: "completed",
    finalAnswer: finalAnswer(),
  });
  assert.match(firstViewer, new RegExp(reasoningSentinel(), "u"));
  assert.match(firstViewer, new RegExp(finalAnswer(), "u"));
  assert.strictEqual(fixture.invocations.length, 2);
  assert.strictEqual(fixture.invocations[0]?.resumeSessionId, undefined);
  assert.strictEqual(fixture.invocations[1]?.resumeSessionId, "codex-thread-1");
  assert.deepStrictEqual(fixture.invocations[1]?.lineage, ["codex"]);
  assert.strictEqual(fixture.invocations[1]?.depth, 1);
});

describe("Codex portable delegation", () => {
  const fixture = makeCodexClient();
  it.live("keeps reasoning viewer-only while preserving the durable resume cursor", () =>
    provePortableDelegation({ fixture }).pipe(
      Effect.provide(portableCodexLayer({ client: fixture.client })),
    ),
  );
});
