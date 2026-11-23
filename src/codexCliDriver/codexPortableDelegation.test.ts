import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";

import { type CaaraAgentApi, runCaaraAgentStart, runCaaraAgentWait } from "../caaraAgentCli.ts";
import { CaaraSettings, defaultCaaraSettingsValue } from "../caaraSettings.ts";
import {
  DelegationMaximumDepth,
  defaultDelegationMaximumDepth,
} from "../mockResponsesProvider/agentDelegation.ts";
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
    post: ({ url, body, headers = {} }) =>
      HttpClientRequest.bodyJson(
        HttpClientRequest.setHeaders(HttpClientRequest.post(new URL(url).pathname), headers),
        body,
      ).pipe(Effect.flatMap(execute), Effect.orDie),
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
const portableCodexLayer = ({
  client,
  maximumDepth = defaultDelegationMaximumDepth,
}: {
  readonly client: CodexCliClient;
  readonly maximumDepth?: number;
}) => {
  const routes = portableAgentRoutesLayerFromTurns({ turnsLayer: portableAgentTurnsLive });
  const server = Layer.effectDiscard(
    Effect.gen(function* () {
      const app = yield* HttpRouter.toHttpEffect(routes);
      yield* HttpServer.serveEffect(app);
    }),
  );
  const driver = createCodexCliAgentDriver({ client });
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
    Layer.provideMerge(Layer.succeed(DelegationMaximumDepth, maximumDepth)),
    Layer.provideMerge(
      Layer.succeed(AgentDriverRegistry, { resolve: () => Effect.succeed(driver) }),
    ),
  );
};

/**
 * Calling-process environment with no inherited host markers; each test adds the markers of the
 * harness it simulates. HOME points at a missing directory so no user config is read.
 */
const callerEnvironment = (
  markers: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({ HOME: "/nonexistent/caara-test-home", ...markers });

/** Starts one Codex turn through CLI adaptation and the real portable HTTP router. */
const startCodexTurn = ({
  api,
  prompt,
  sessionId,
  env = callerEnvironment(),
}: {
  readonly api: CaaraAgentApi;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly env?: Readonly<Record<string, string>>;
}) =>
  runCaaraAgentStart({
    args: ["--host", "127.0.0.1", "--port", "8787"],
    prompt,
    target: "codex/gpt-5.6-codex",
    cwd: projectRoot,
    driverOptions: {},
    sessionId,
    api,
    env,
  });

/** Proves public CLI/HTTP projection, human observation, and durable Codex resume behavior. */
const provePortableDelegation = Effect.fnUntraced(function* ({
  fixture,
}: {
  readonly fixture: ReturnType<typeof makeCodexClient>;
}) {
  const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
  const first = yield* startCodexTurn({
    api,
    prompt: "first portable Codex prompt",
    env: callerEnvironment({ CLAUDECODE: "1" }),
  });
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
    env: callerEnvironment({ CAARA_HARNESS: "agy", CAARA_DELEGATION_DEPTH: "2" }),
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
  assert.strictEqual(fixture.invocations[0]?.prompt, "first portable Codex prompt");
  assert.deepStrictEqual(fixture.invocations[0]?.delegationEnvironment, {
    CAARA_HARNESS: "codex",
    CAARA_DELEGATION_DEPTH: "1",
  });
  assert.deepStrictEqual(fixture.invocations[1]?.delegationEnvironment, {
    CAARA_HARNESS: "codex",
    CAARA_DELEGATION_DEPTH: "3",
  });
});

/** Starts one Codex turn expected to fail, returning its typed CLI error. */
const rejectedCodexStart = ({
  api,
  env,
}: {
  readonly api: CaaraAgentApi;
  readonly env: Readonly<Record<string, string>>;
}) =>
  startCodexTurn({ api, prompt: "rejected portable Codex prompt", env }).pipe(
    Effect.catchTag("CaaraSettingsError", (error) => Effect.die(error)),
    Effect.flip,
  );

describe("Codex portable delegation", () => {
  const fixture = makeCodexClient();
  it.live("keeps reasoning viewer-only while preserving the durable resume cursor", () =>
    provePortableDelegation({ fixture }).pipe(
      Effect.provide(portableCodexLayer({ client: fixture.client })),
    ),
  );

  it.live("rejects Codex calling Codex before the Codex executable starts", () => {
    const rejected = makeCodexClient();
    return Effect.gen(function* () {
      const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
      const nativeError = yield* rejectedCodexStart({
        api,
        env: callerEnvironment({ CODEX_THREAD_ID: "codex-thread-native" }),
      });
      const injectedError = yield* rejectedCodexStart({
        api,
        env: callerEnvironment({ CAARA_HARNESS: "codex", CAARA_DELEGATION_DEPTH: "1" }),
      });
      for (const error of [nativeError, injectedError]) {
        assert.strictEqual(error.kind, "target_failure");
        assert.match(error.message, /Codex's native subagents \(spawn_agent\)/u);
      }
      assert.strictEqual(rejected.invocations.length, 0);
    }).pipe(Effect.provide(portableCodexLayer({ client: rejected.client })));
  });

  it.live("rejects the harness entry beyond the default maximum depth before spawning", () => {
    const bounded = makeCodexClient();
    return Effect.gen(function* () {
      const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
      yield* startCodexTurn({
        api,
        prompt: "third harness entry",
        env: callerEnvironment({ CAARA_HARNESS: "claude", CAARA_DELEGATION_DEPTH: "2" }),
      });
      const error = yield* rejectedCodexStart({
        api,
        env: callerEnvironment({ CAARA_HARNESS: "claude", CAARA_DELEGATION_DEPTH: "3" }),
      });
      assert.strictEqual(error.kind, "target_failure");
      assert.match(error.message, /depth 3 reached the configured maximum 3/u);
      assert.strictEqual(bounded.invocations.length, 1);
    }).pipe(Effect.provide(portableCodexLayer({ client: bounded.client })));
  });

  it.live("applies a configured maximum depth", () => {
    const configured = makeCodexClient();
    return Effect.gen(function* () {
      const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
      const error = yield* rejectedCodexStart({
        api,
        env: callerEnvironment({ CAARA_HARNESS: "claude", CAARA_DELEGATION_DEPTH: "1" }),
      });
      assert.match(error.message, /depth 1 reached the configured maximum 1/u);
      assert.strictEqual(configured.invocations.length, 0);
    }).pipe(Effect.provide(portableCodexLayer({ client: configured.client, maximumDepth: 1 })));
  });

  it.live("lets raw HTTP marker headers only restrict, never loosen, a direct start", () => {
    const raw = makeCodexClient();
    return Effect.gen(function* () {
      const statuses = yield* Effect.forEach(
        [
          {},
          { "x-caara-harness": "claude", "x-caara-delegation-depth": "0" },
          { "x-caara-harness": "codex" },
          { "x-caara-harness": "claude", "x-caara-delegation-depth": "3" },
        ],
        (headers) =>
          HttpClientRequest.bodyJson(
            HttpClientRequest.setHeaders(HttpClientRequest.post("/agent/turns"), headers),
            {
              prompt: "raw caller prompt",
              target: "codex/gpt-5.6",
              cwd: projectRoot,
              driverOptions: {},
            },
          ).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.map((response) => response.status),
          ),
      );
      assert.deepStrictEqual(statuses, [200, 200, 422, 422]);
      assert.deepStrictEqual(
        raw.invocations.map(({ delegationEnvironment }) => delegationEnvironment),
        [
          { CAARA_HARNESS: "codex", CAARA_DELEGATION_DEPTH: "1" },
          { CAARA_HARNESS: "codex", CAARA_DELEGATION_DEPTH: "1" },
        ],
      );
    }).pipe(Effect.provide(portableCodexLayer({ client: raw.client })));
  });

  it.live("fails explicitly on conflicting native markers without contacting the harness", () => {
    const conflicted = makeCodexClient();
    return Effect.gen(function* () {
      const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
      const error = yield* rejectedCodexStart({
        api,
        env: callerEnvironment({ CLAUDECODE: "1", CODEX_THREAD_ID: "codex-thread-native" }),
      });
      assert.strictEqual(error.kind, "invalid_request");
      assert.match(error.message, /Conflicting native harness markers \(claude, codex\)/u);
      assert.strictEqual(conflicted.invocations.length, 0);
    }).pipe(Effect.provide(portableCodexLayer({ client: conflicted.client })));
  });
});
