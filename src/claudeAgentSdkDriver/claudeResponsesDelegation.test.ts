import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "../mockResponsesProvider/inputLogger.ts";
import { RelayLogger } from "../mockResponsesProvider/relayLogger.ts";
import { RequestDiagnosticsLogger } from "../mockResponsesProvider/requestDiagnosticsLogger.ts";
import {
  failedErrorCodeFromResponseFrames,
  failedErrorMessageFromResponseFrames,
} from "../mockResponsesProvider/responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "../mockResponsesProvider/server.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import {
  fakeSdkHarness,
  sdkContentBlockStop,
  sdkSuccessResultMessage,
  sdkTextBlockStart,
  sdkTextDelta,
} from "./claudeAgentSdkDriverTestHarness.ts";

/** Project root used as the Codex workspace path for Responses delegation turns. */
const projectRoot = process.cwd();

/** Stable fake Claude SDK session id used by successful Responses delegation turns. */
const sdkSessionId = (): string => "00000000-0000-4000-8000-00000000d101";

/** Codex thread id shared by the Responses delegation requests. */
const threadId = (): string => "codex-thread-responses-delegation";

/** Builds the Codex turn metadata header value for one Responses delegation request. */
const turnMetadata = (turnId: string): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)({
    installation_id: "install-responses-delegation",
    session_id: "parent-session-responses-delegation",
    thread_id: threadId(),
    turn_id: turnId,
    window_id: "window-responses-delegation",
    request_kind: "turn",
    parent_thread_id: "parent-thread-responses-delegation",
    subagent_kind: "caara",
    sandbox: "workspace-write",
    workspaces: { [projectRoot]: { latest_git_commit_hash: "abcdef0", has_changes: false } },
    turn_started_at_unix_ms: 1,
  });

/** Builds the verified Codex subagent identity headers plus optional Caara marker headers. */
const codexHeaders = ({
  turnId,
  markers,
}: {
  readonly turnId: string;
  readonly markers: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-responses-delegation",
  "thread-id": threadId(),
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-responses-delegation",
  "x-codex-turn-metadata": turnMetadata(turnId),
  "x-codex-window-id": "window-responses-delegation",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
  ...markers,
});

/** Builds a Responses server backed by one fake Claude SDK runtime and isolated state. */
const responsesHarness = () => {
  const harness = fakeSdkHarness({
    sessionIds: [sdkSessionId()],
    runtimeMessages: [
      [
        sdkTextBlockStart({ sessionId: sdkSessionId(), index: 0 }),
        sdkTextDelta({ sessionId: sdkSessionId(), index: 0, text: "delegated answer" }),
        sdkContentBlockStop({ sessionId: sdkSessionId(), index: 0 }),
        sdkSuccessResultMessage({ sessionId: sdkSessionId() }),
      ],
    ],
  });
  return {
    harness,
    layer: mockResponsesServerLayer.pipe(
      Layer.provideMerge(BunHttpServer.layerTest),
      Layer.provideMerge(Layer.succeed(InputLogger, { logInput: () => Effect.void })),
      Layer.provideMerge(
        Layer.succeed(RequestDiagnosticsLogger, { logRequest: () => Effect.void }),
      ),
      Layer.provideMerge(Layer.succeed(RelayLogger, { log: () => Effect.void })),
      Layer.provideMerge(
        sessionDirectoryBunTestLayer({
          stateDir: path.join(projectRoot, "temp.local", `responses-delegation-${randomUUID()}`),
        }),
      ),
      Layer.provideMerge(turnConcurrencyLive),
      Layer.provideMerge(harness.layer),
    ),
  };
};

/** Sends one Codex-shaped streaming Responses request and decodes its SSE frames. */
const sendResponsesTurn = Effect.fnUntraced(function* ({
  model,
  markers = {},
}: {
  readonly model: string;
  readonly markers?: Readonly<Record<string, string>>;
}) {
  const turnId = `turn-${randomUUID()}`;
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.setHeaders(
      HttpClientRequest.post("/v1/responses"),
      codexHeaders({ turnId, markers }),
    ),
    {
      model,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
      stream: true,
      client_metadata: { thread_id: threadId(), turn_id: turnId },
      metadata: { cwd: projectRoot },
    },
  );
  const response = yield* HttpClient.execute(request);
  const body = yield* response.text;
  const frames = yield* Stream.make(body).pipe(
    Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)),
    Stream.runCollect,
  );
  return { status: response.status, body, frames: [...frames] };
});

describe("Responses delegation context", () => {
  it.live("treats the verified Codex transport as the caller and injects depth 1", () => {
    const { harness, layer } = responsesHarness();
    return Effect.gen(function* () {
      const result = yield* sendResponsesTurn({ model: "claude/sonnet" });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(harness.recordedRequests.length, 1);
      assert.strictEqual(harness.recordedRequests[0]?.options.env?.CAARA_HARNESS, "claude");
      assert.strictEqual(harness.recordedRequests[0]?.options.env?.CAARA_DELEGATION_DEPTH, "1");
    }).pipe(Effect.provide(layer));
  });

  it.live("continues the depth forwarded by a Caara-spawned Codex role", () => {
    const { harness, layer } = responsesHarness();
    return Effect.gen(function* () {
      yield* sendResponsesTurn({
        model: "claude/sonnet",
        markers: { "x-caara-harness": "codex", "x-caara-delegation-depth": "2" },
      });
      assert.strictEqual(harness.recordedRequests[0]?.options.env?.CAARA_DELEGATION_DEPTH, "3");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails the fourth harness entry before any SDK query starts", () => {
    const { harness, layer } = responsesHarness();
    return Effect.gen(function* () {
      const result = yield* sendResponsesTurn({
        model: "claude/sonnet",
        markers: { "x-caara-harness": "codex", "x-caara-delegation-depth": "3" },
      });
      assert.strictEqual(failedErrorCodeFromResponseFrames(result.frames), "invalid_prompt");
      assert.match(
        failedErrorMessageFromResponseFrames(result.frames) ?? "",
        /depth 3 reached the configured maximum 3/u,
      );
      assert.strictEqual(harness.recordedRequests.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects Codex delegating to Codex with the native subagent alternative", () => {
    const { harness, layer } = responsesHarness();
    return Effect.gen(function* () {
      const result = yield* sendResponsesTurn({ model: "codex/gpt-5.6" });
      assert.match(
        failedErrorMessageFromResponseFrames(result.frames) ?? "",
        /Codex's native subagents \(spawn_agent\)/u,
      );
      assert.strictEqual(harness.recordedRequests.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a Caara marker that contradicts the Codex transport", () => {
    const { harness, layer } = responsesHarness();
    return Effect.gen(function* () {
      const result = yield* sendResponsesTurn({
        model: "claude/sonnet",
        markers: { "x-caara-harness": "agy", "x-caara-delegation-depth": "1" },
      });
      assert.strictEqual(result.status, 400);
      assert.match(result.body, /Conflicting delegation markers/u);
      assert.strictEqual(harness.recordedRequests.length, 0);
    }).pipe(Effect.provide(layer));
  });
});
