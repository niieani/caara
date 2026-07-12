import { randomUUID } from "node:crypto";
import path from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schedule } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";

import {
  type CaaraAgentApi,
  runCaaraAgentCancel,
  runCaaraAgentStart,
  runCaaraAgentWait,
} from "../caaraAgentCli.ts";
import { RelayLogger } from "../mockResponsesProvider/relayLogger.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { portableAgentRoutesLayerFromTurns } from "../portableAgentHttp.ts";
import { portableAgentTurnsLive } from "../portableAgentTurn.ts";
import {
  fakeSdkHarness as fakeCancellationHarness,
  sdkResult as sdkCancellationResult,
  sdkThinkingDelta as sdkCancellationThinkingDelta,
} from "./claudeAgentSdkCancellationHarness.ts";
import {
  fakeSdkHarness,
  sdkContentBlockStop,
  sdkSuccessResultMessage,
  sdkTextBlockStart,
  sdkTextDelta,
  sdkThinkingBlockStart,
  sdkThinkingDelta,
} from "./claudeAgentSdkDriverTestHarness.ts";

/** Stable project root passed through the public portable working-directory contract. */
const projectRoot = process.cwd();

/** Deterministic external Claude session ids used by portable integration scenarios. */
const sdkSessionIds = {
  firstResume: "00000000-0000-4000-8000-000000000801",
  cancellation: "00000000-0000-4000-8000-000000000802",
} as const;

/** Reads one test-server response through the same JSON shape consumed by the CLI adapter. */
/** Real HTTP adapter backed by Effect's scoped test server and used by in-process CLI commands. */
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

/** Serves only portable routes with injected fake Claude SDK and isolated session state. */
const portableClaudeLayer = ({
  runtimeMessages,
  sessionIds,
}: {
  readonly runtimeMessages: readonly (readonly SDKMessage[])[];
  readonly sessionIds: readonly string[];
}) => {
  const harness = fakeSdkHarness({ runtimeMessages, sessionIds });
  const routes = portableAgentRoutesLayerFromTurns({ turnsLayer: portableAgentTurnsLive });
  const server = Layer.effectDiscard(
    Effect.gen(function* () {
      const app = yield* HttpRouter.toHttpEffect(routes);
      yield* HttpServer.serveEffect(app);
    }),
  );
  return {
    harness,
    layer: server.pipe(
      Layer.provideMerge(BunHttpServer.layerTest),
      Layer.provideMerge(
        sessionDirectoryBunTestLayer({
          stateDir: path.join(
            projectRoot,
            "temp.local",
            "2026-07-12",
            `claude-portable-${randomUUID()}`,
          ),
        }),
      ),
      Layer.provideMerge(harness.layer),
      Layer.provideMerge(Layer.succeed(RelayLogger, { log: () => Effect.void })),
      Layer.provideMerge(turnConcurrencyLive),
    ),
  };
};

/** Starts one Claude portable turn through the public CLI adapter and real HTTP router. */
const startClaudeTurn = ({
  api,
  prompt,
  sessionId,
}: {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly api: CaaraAgentApi;
}) =>
  runCaaraAgentStart({
    args: ["--host", "127.0.0.1", "--port", "8787"],
    prompt,
    target: "claude/sonnet",
    cwd: projectRoot,
    driverOptions: { effort: "max", max_budget_usd: "0.75" },
    sessionId,
    api,
  });

describe("Claude portable delegation", () => {
  it.live("starts and resumes through CLI+HTTP while keeping activity viewer-only", () => {
    const firstSdkSession = sdkSessionIds.firstResume;
    const harness = portableClaudeLayer({
      sessionIds: [firstSdkSession],
      runtimeMessages: [
        [
          sdkThinkingBlockStart({ sessionId: firstSdkSession }),
          sdkThinkingDelta({ sessionId: firstSdkSession, thinking: "private first activity" }),
          sdkTextBlockStart({ sessionId: firstSdkSession, index: 1 }),
          sdkTextDelta({ sessionId: firstSdkSession, index: 1, text: "safe first answer" }),
          sdkContentBlockStop({ sessionId: firstSdkSession, index: 1 }),
          sdkSuccessResultMessage({ sessionId: firstSdkSession }),
        ],
        [
          sdkThinkingBlockStart({ sessionId: firstSdkSession }),
          sdkThinkingDelta({ sessionId: firstSdkSession, thinking: "private resumed activity" }),
          sdkTextBlockStart({ sessionId: firstSdkSession, index: 1 }),
          sdkTextDelta({ sessionId: firstSdkSession, index: 1, text: "safe resumed answer" }),
          sdkContentBlockStop({ sessionId: firstSdkSession, index: 1 }),
          sdkSuccessResultMessage({ sessionId: firstSdkSession }),
        ],
      ],
    });

    return Effect.gen(function* () {
      const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
      const first = yield* startClaudeTurn({ prompt: "first portable prompt", api });
      const firstWait = yield* runCaaraAgentWait({
        args: [],
        turnId: first.turnId,
        timeoutMillis: 250,
        api,
      });
      const firstViewer = yield* HttpClient.execute(
        HttpClientRequest.get(new URL(first.observationUrl).pathname),
      ).pipe(Effect.flatMap((response) => response.text));
      const resumed = yield* startClaudeTurn({
        prompt: "resumed portable prompt",
        sessionId: first.sessionId,
        api,
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
        finalAnswer: "safe first answer",
      });
      assert.deepStrictEqual(resumedWait, {
        schemaVersion: 1,
        status: "completed",
        finalAnswer: "safe resumed answer",
      });
      assert.match(firstViewer, /private first activity/u);
      assert.strictEqual(harness.harness.recordedRequests.length, 2);
      assert.strictEqual(harness.harness.recordedRequests[0]?.options.cwd, projectRoot);
      assert.strictEqual(harness.harness.recordedRequests[0]?.options.model, "sonnet");
      assert.strictEqual(harness.harness.recordedRequests[0]?.options.effort, "max");
      assert.strictEqual(harness.harness.recordedRequests[0]?.options.maxBudgetUsd, 0.75);
      assert.strictEqual(harness.harness.recordedRequests[1]?.options.resume, firstSdkSession);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("cancels through HTTP and exposes reusable cancellation only to the viewer", () => {
    const firstSdkSession = sdkSessionIds.cancellation;
    const sdkHarness = fakeCancellationHarness({
      sessionIds: [firstSdkSession],
      runtimeConfigs: [
        {
          messages: [
            sdkThinkingBlockStart({ sessionId: firstSdkSession }),
            sdkCancellationThinkingDelta({
              sessionId: firstSdkSession,
              thinking: "private cancellation activity",
            }),
          ],
          waitForInterrupt: true,
          interruptMessages: [
            sdkCancellationResult({
              sessionId: firstSdkSession,
              terminalReason: "aborted_streaming",
            }),
          ],
        },
      ],
    });
    const routes = portableAgentRoutesLayerFromTurns({ turnsLayer: portableAgentTurnsLive });
    const server = Layer.effectDiscard(
      Effect.gen(function* () {
        const app = yield* HttpRouter.toHttpEffect(routes);
        yield* HttpServer.serveEffect(app);
      }),
    );
    const layer = server.pipe(
      Layer.provideMerge(BunHttpServer.layerTest),
      Layer.provideMerge(
        sessionDirectoryBunTestLayer({
          stateDir: path.join(
            projectRoot,
            "temp.local",
            "2026-07-12",
            `claude-portable-cancel-${randomUUID()}`,
          ),
        }),
      ),
      Layer.provideMerge(sdkHarness.layer),
      Layer.provideMerge(Layer.succeed(RelayLogger, { log: () => Effect.void })),
      Layer.provideMerge(turnConcurrencyLive),
    );

    return Effect.gen(function* () {
      const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
      const started = yield* startClaudeTurn({ prompt: "cancel this turn", api });
      yield* HttpClient.execute(
        HttpClientRequest.get(new URL(started.observationUrl).pathname),
      ).pipe(
        Effect.flatMap((response) => response.text),
        Effect.filterOrFail((html) => html.includes("private cancellation activity")),
        Effect.retry(Schedule.both(Schedule.spaced("10 millis"), Schedule.recurs(20))),
      );
      const cancelled = yield* runCaaraAgentCancel({
        args: [],
        turnId: started.turnId,
        api,
      });
      const cancellationViewer = yield* HttpClient.execute(
        HttpClientRequest.get(new URL(started.observationUrl).pathname),
      ).pipe(Effect.flatMap((response) => response.text));
      assert.deepStrictEqual(cancelled, {
        schemaVersion: 1,
        status: "cancelled",
        outcome: "Interrupted",
        sessionReusable: true,
      });
      assert.match(cancellationViewer, /Status: cancelled/u);
      assert.match(cancellationViewer, /private cancellation activity/u);
      assert.match(cancellationViewer, /Session reusable: true/u);
      assert.deepStrictEqual(sdkHarness.controls[0]?.interrupts, ["interrupt"]);
    }).pipe(Effect.provide(layer));
  });
});
