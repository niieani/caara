import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "../mockResponsesProvider/inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "../mockResponsesProvider/relayLogger.ts";
import { RequestDiagnosticsLogger } from "../mockResponsesProvider/requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "../mockResponsesProvider/server.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { antigravityCliDriverLayer } from "./driver.ts";
import { fakeAgyFixture, fakeAgyScript } from "./fakeAgyScript.ts";
import { AntigravityCliSettings } from "./settings.ts";

/** Project root used as the Codex workspace path in Antigravity activity tests. */
const projectRoot = process.cwd();

/** Test fixture failure for Antigravity activity provider setup. */
class AntigravityCliActivityTestError extends Schema.TaggedErrorClass<AntigravityCliActivityTestError>()(
  "AntigravityCliActivityTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged activity test error. */
const activityTestError = (cause: unknown): AntigravityCliActivityTestError =>
  new AntigravityCliActivityTestError({ message: String(cause) });

/** Builds Codex turn metadata for one Antigravity activity test turn. */
const makeTurnMetadata = ({
  turnId,
}: {
  readonly turnId: string;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-activity",
  session_id: "parent-session-activity",
  thread_id: "codex-thread-agy-activity",
  turn_id: turnId,
  window_id: "window-activity",
  request_kind: "turn",
  parent_thread_id: "parent-thread-activity",
  subagent_kind: "caara",
  sandbox: "workspace-write",
  workspaces: {
    [projectRoot]: {
      latest_git_commit_hash: "abcdef0",
      has_changes: true,
    },
  },
  turn_started_at_unix_ms: 1,
});

/** Builds Codex headers for one Antigravity activity test turn. */
const makeHeaders = ({
  turnId,
}: {
  readonly turnId: string;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-activity",
  "thread-id": "codex-thread-agy-activity",
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-activity",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ turnId }),
  ),
  "x-codex-window-id": "window-activity",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming request body for one Antigravity activity turn. */
const makeBody = ({ turnId }: { readonly turnId: string }): Schema.Json => ({
  model: "agy/gemini-3.5-flash",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `activity ${turnId}` }],
    },
  ],
  stream: true,
  client_metadata: {
    thread_id: "codex-thread-agy-activity",
    turn_id: turnId,
  },
  metadata: {
    cwd: projectRoot,
  },
});

/** Applies Codex header fixtures to one activity test HTTP request. */
const setHeaders = ({
  request,
  headers,
}: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly headers: Readonly<Record<string, string>>;
}): HttpClientRequest.HttpClientRequest => {
  let nextRequest = request;
  for (const [name, value] of Object.entries(headers)) {
    nextRequest = nextRequest.pipe(HttpClientRequest.setHeader(name, value));
  }
  return nextRequest;
};

/** No-op request input logger layer for provider-boundary activity tests. */
const inputLoggerNoopLayer = Layer.succeed(InputLogger, {
  logInput: Effect.fnUntraced(function* () {
    yield* Effect.void;
  }),
});

/** No-op request diagnostics logger layer for provider-boundary activity tests. */
const diagnosticsLoggerNoopLayer = Layer.succeed(RequestDiagnosticsLogger, {
  logRequest: Effect.fnUntraced(function* () {
    yield* Effect.void;
  }),
});

/** Capture logger layer for relay event assertions. */
const relayLoggerLayer = (events: Array<RelayLogEvent>) =>
  Layer.succeed(RelayLogger, {
    log: Effect.fnUntraced(function* (event: RelayLogEvent) {
      yield* Effect.sync(() => events.push(event));
    }),
  });

/** Builds a fresh provider layer backed by the fake Antigravity CLI activity mode. */
const providerLayer = ({
  stateDir,
  fakeAgyPath,
  fakeHomeDir,
  invocationLogPath,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(inputLoggerNoopLayer),
    Layer.provideMerge(diagnosticsLoggerNoopLayer),
    Layer.provideMerge(relayLoggerLayer(relayEvents)),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(antigravityCliDriverLayer),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(
      Layer.succeed(AntigravityCliSettings, {
        command: fakeAgyPath,
        homeDir: fakeHomeDir,
        allowDangerousSkipPermissions: false,
        environment: {
          AGY_FAKE_INVOCATION_LOG: invocationLogPath,
          AGY_FAKE_MODE: "reasoning-activity",
        },
      }),
    ),
  );

/** Decodes raw Responses SSE frames without dropping extension fields such as message phase. */
const decodeUnknownResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Creates a fresh project-local fixture directory for one Antigravity activity test. */
const makeFixture = Effect.fnUntraced(function* () {
  const tempRoot = path.join(
    projectRoot,
    "temp.local",
    "2026-06-23",
    "antigravity-cli-activity-tests",
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: activityTestError,
  });
  const root = yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `fixture-${randomUUID()}-`)),
    catch: activityTestError,
  });
  const fakeHomeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const fakeAgyPath = path.join(binDir, "agy");
  const invocationLogPath = path.join(root, "invocations.jsonl");
  const stateDir = path.join(root, "state");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(binDir, { recursive: true }),
    catch: activityTestError,
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(fakeAgyPath, fakeAgyScript, { mode: 0o755 }),
    catch: activityTestError,
  });
  return { fakeAgyPath, fakeHomeDir, invocationLogPath, stateDir };
});

/** Runs one activity turn through the provider and returns raw SSE frames. */
const runActivityTurnFrames = ({
  stateDir,
  fakeAgyPath,
  fakeHomeDir,
  invocationLogPath,
  queryString,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
  readonly queryString: string;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(`/v1/responses${queryString}`),
        makeBody({ turnId: "turn-antigravity-activity" }),
      ),
      headers: makeHeaders({ turnId: "turn-antigravity-activity" }),
    });
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeUnknownResponseSseFrames(response.stream);
    assert.strictEqual(response.status, 200);
    return frames;
  }).pipe(
    Effect.provide(
      providerLayer({
        stateDir,
        fakeAgyPath,
        fakeHomeDir,
        invocationLogPath,
        relayEvents,
      }),
    ),
  );

/** Schema used to extract assistant message completion items from raw SSE frame data. */
const AssistantMessageDoneData = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Struct({
    type: Schema.Literal("message"),
    phase: Schema.optional(
      Schema.Union([Schema.Literal("commentary"), Schema.Literal("final_answer")]),
    ),
    content: Schema.Array(
      Schema.Struct({
        type: Schema.Literal("output_text"),
        text: Schema.String,
      }),
    ),
  }),
});

/** Assistant message done data decoded from raw Responses SSE frames. */
type AssistantMessageDoneData = typeof AssistantMessageDoneData.Type;

/** Schema used to extract visible reasoning-summary deltas from raw SSE frame data. */
const ReasoningSummaryDeltaData = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  delta: Schema.String,
});

/** Returns completed assistant message data from raw decoded SSE frames. */
const assistantMessageDoneData = (
  frames: readonly { readonly data: unknown }[],
): readonly AssistantMessageDoneData[] =>
  frames.map((frame) => frame.data).filter(Schema.is(AssistantMessageDoneData));

/** Extracts the first text content from one completed assistant message item. */
const messageText = (message: AssistantMessageDoneData): string => {
  const content = message.item.content.at(0);
  assert.ok(content, "assistant message must include text content");
  return content.text;
};

/** Returns visible reasoning-summary text deltas from raw decoded SSE frames. */
const reasoningSummaryDeltaTexts = (
  frames: readonly { readonly data: unknown }[],
): readonly string[] =>
  frames
    .map((frame) => frame.data)
    .filter(Schema.is(ReasoningSummaryDeltaData))
    .map((data) => data.delta);

/** Returns runtime event tags captured by the relay logger. */
const runtimeEventTags = (events: readonly RelayLogEvent[]): readonly string[] =>
  events
    .filter((event) => event._tag === "RuntimeEventRelayed")
    .map((event) => event.runtimeEventTag);

describe("Antigravity CLI driver activity visibility", () => {
  it.effect("applies reasoning and activity opt-outs while preserving final text", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const relayEvents: Array<RelayLogEvent> = [];
      const frames = yield* runActivityTurnFrames({
        ...fixture,
        queryString: "?reasoning=off&activity=off",
        relayEvents,
      });
      const messages = assistantMessageDoneData(frames);

      assert.deepStrictEqual(
        messages.map((message) => [message.item.phase, messageText(message)]),
        [["final_answer", fakeAgyFixture.finalAnswer]],
      );
      assert.deepStrictEqual(reasoningSummaryDeltaTexts(frames), []);
      assert.strictEqual(
        runtimeEventTags(relayEvents).filter((tag) => tag === "ItemCreated").length,
        3,
      );
    }),
  );
});
