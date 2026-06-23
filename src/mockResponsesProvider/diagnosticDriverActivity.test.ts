import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { diagnosticAgentDriverRegistryLive, diagnosticDriverFixture } from "./diagnosticDriver.ts";
import { InputLogger } from "./inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Project root used as the Codex workspace path in diagnostic activity tests. */
const projectRoot = process.cwd();

/** Stable Codex thread id used to isolate diagnostic activity bindings. */
const makeThreadId = (): string => "codex-thread-diagnostic-activity";

/** Test fixture failure for diagnostic activity provider setup. */
class DiagnosticDriverActivityTestError extends Schema.TaggedErrorClass<DiagnosticDriverActivityTestError>()(
  "DiagnosticDriverActivityTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged diagnostic activity test error. */
const diagnosticDriverActivityTestError = (cause: unknown): DiagnosticDriverActivityTestError =>
  new DiagnosticDriverActivityTestError({ message: String(cause) });

/** Builds Codex turn metadata for one diagnostic activity request. */
const makeTurnMetadata = (turnId: string): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-diagnostic-activity",
  session_id: "parent-session-diagnostic-activity",
  thread_id: makeThreadId(),
  turn_id: turnId,
  window_id: "window-diagnostic-activity",
  request_kind: "turn",
  parent_thread_id: "parent-thread-diagnostic-activity",
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

/** Builds complete Codex headers for one diagnostic activity request. */
const makeHeaders = (turnId: string): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-diagnostic-activity",
  "thread-id": makeThreadId(),
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-diagnostic-activity",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata(turnId),
  ),
  "x-codex-window-id": "window-diagnostic-activity",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for diagnostic/activity. */
const makeBody = (turnId: string): Schema.Json => ({
  model: "diagnostic/activity",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `activity ${turnId}` }],
    },
  ],
  stream: true,
  client_metadata: {
    thread_id: makeThreadId(),
    turn_id: turnId,
  },
  metadata: { cwd: projectRoot },
});

/** Applies Codex identity headers to one outgoing test request. */
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

/** Builds a capture logger layer for request inputs. */
const inputLoggerLayer = (inputs: Array<Schema.Json>) =>
  Layer.succeed(InputLogger, {
    logInput: Effect.fnUntraced(function* (input: Schema.Json) {
      yield* Effect.sync(() => inputs.push(input));
    }),
  });

/** Builds a capture logger layer for request diagnostics. */
const diagnosticsLoggerLayer = (diagnostics: Array<ResponsesRequestDiagnostics>) =>
  Layer.succeed(RequestDiagnosticsLogger, {
    logRequest: Effect.fnUntraced(function* (entry: ResponsesRequestDiagnostics) {
      yield* Effect.sync(() => diagnostics.push(entry));
    }),
  });

/** Builds a capture logger layer for relay events. */
const relayLoggerLayer = (events: Array<RelayLogEvent>) =>
  Layer.succeed(RelayLogger, {
    log: Effect.fnUntraced(function* (event: RelayLogEvent) {
      yield* Effect.sync(() => events.push(event));
    }),
  });

/** Builds a fresh provider test layer backed by one shared session state directory. */
const providerLayer = ({
  stateDir,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(inputLoggerLayer(inputs)),
    Layer.provideMerge(diagnosticsLoggerLayer(diagnostics)),
    Layer.provideMerge(relayLoggerLayer(relayEvents)),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(diagnosticAgentDriverRegistryLive),
  );

/** Decodes raw Responses SSE frame data without dropping extension fields such as phase. */
const decodeUnknownResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Creates a fresh state directory under project-local temp.local. */
const makeStateDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: diagnosticDriverActivityTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `diagnostic-activity-${randomUUID()}-`)),
    catch: diagnosticDriverActivityTestError,
  });
});

/** Runs one diagnostic/activity turn through the provider boundary. */
const runDiagnosticActivityTurn = ({
  stateDir,
  turnId,
  url,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly url: string;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url), makeBody(turnId)),
      headers: makeHeaders(turnId),
    });
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeUnknownResponseSseFrames(response.stream);
    assert.strictEqual(response.status, 200);
    return frames;
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Schema used to extract assistant message completion items from raw SSE data. */
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

/** Assistant message done data decoded from a raw Responses SSE frame. */
type AssistantMessageDoneData = typeof AssistantMessageDoneData.Type;

/** Returns completed assistant message items from raw decoded SSE frames. */
const assistantMessageDoneData = (
  frames: readonly { readonly data: unknown }[],
): readonly AssistantMessageDoneData[] =>
  frames.map((frame) => frame.data).filter(Schema.is(AssistantMessageDoneData));

/** Extracts the first text content from a completed assistant message item. */
const messageText = (message: AssistantMessageDoneData): string => {
  const content = message.item.content.at(0);
  assert.ok(content, "missing assistant content");
  return content.text;
};

/** Returns all decoded SSE event names in order. */
const eventNames = (frames: readonly { readonly event: string }[]): readonly string[] =>
  frames.map((frame) => frame.event);

/** Returns relay event tags in order. */
const relayEventTags = (events: readonly RelayLogEvent[]): readonly string[] =>
  events.map((event) => event._tag);

describe("diagnostic activity driver", () => {
  it.effect("emits terse commentary messages and a final answer by default", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const frames = yield* runDiagnosticActivityTurn({
        stateDir,
        turnId: "turn-diagnostic-activity-default",
        url: "/v1/responses",
        inputs,
        diagnostics,
        relayEvents,
      });
      const messages = assistantMessageDoneData(frames);

      assert.deepStrictEqual(
        messages.map((message) => [message.item.phase, messageText(message)]),
        [
          ["commentary", diagnosticDriverFixture.activityReadingText],
          ["commentary", diagnosticDriverFixture.activityEditingText],
          ["final_answer", diagnosticDriverFixture.activityAnswerText],
        ],
      );
      assert.strictEqual(
        eventNames(frames).includes("response.function_call_arguments.delta"),
        false,
      );
      assert.strictEqual(
        eventNames(frames).includes("response.custom_tool_call_input.delta"),
        false,
      );
      assert.deepStrictEqual(
        relayEvents
          .filter((event) => event._tag === "RuntimeEventRelayed")
          .map((event) => event.runtimeEventTag),
        [
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "TurnSucceeded",
        ],
      );
      assert.deepStrictEqual(inputs.length, 1);
      assert.deepStrictEqual(diagnostics.length, 1);
    }),
  );

  it.effect("disables visible commentary while preserving final answer and relay records", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const frames = yield* runDiagnosticActivityTurn({
        stateDir,
        turnId: "turn-diagnostic-activity-opt-out",
        url: "/v1/responses?diagnostic_activity=off",
        inputs,
        diagnostics,
        relayEvents,
      });
      const messages = assistantMessageDoneData(frames);

      assert.deepStrictEqual(
        messages.map((message) => [message.item.phase, messageText(message)]),
        [["final_answer", diagnosticDriverFixture.activityAnswerText]],
      );
      assert.deepStrictEqual(relayEventTags(relayEvents).at(0), "TurnAccepted");
      assert.deepStrictEqual(relayEventTags(relayEvents).at(-1), "TurnCompleted");
      assert.deepStrictEqual(
        relayEvents
          .filter((event) => event._tag === "RuntimeEventRelayed")
          .map((event) => event.runtimeEventTag),
        [
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "TurnSucceeded",
        ],
      );
      assert.deepStrictEqual(inputs.length, 1);
      assert.deepStrictEqual(diagnostics.length, 1);
    }),
  );
});
