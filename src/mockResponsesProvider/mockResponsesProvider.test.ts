import { randomUUID } from "node:crypto";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "./inputLogger.ts";
import { mockResponsesFixture } from "./protocol.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { isAssistantMessageDoneData } from "./responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { simulatorAgentDriverRegistryLive, simulatorDriverFixture } from "./simulatorDriver.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Stable project root used as a realistic Codex workspace path in transport tests. */
const projectRoot = process.cwd();

/** Stable Codex turn id used by the valid transport fixture. */
const makeTurnId = (): string => "turn-http-1";

/** Builds Codex turn metadata with optional field overrides. */
const makeTurnMetadata = (
  overrides: Readonly<Record<string, Schema.Json>> = {},
): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: "codex-thread-1",
  turn_id: makeTurnId(),
  window_id: "window-1",
  request_kind: "turn",
  parent_thread_id: "parent-thread-1",
  subagent_kind: "caara",
  sandbox: "workspace-write",
  workspaces: {
    [projectRoot]: {
      latest_git_commit_hash: "abcdef0",
      has_changes: true,
    },
  },
  turn_started_at_unix_ms: 1,
  ...overrides,
});

/** Builds complete Codex request headers for one HTTP request. */
const makeCodexHeaders = ({
  metadata = makeTurnMetadata(),
  overrides = {},
}: {
  readonly metadata?: Readonly<Record<string, Schema.Json>>;
  readonly overrides?: Readonly<Record<string, string>>;
} = {}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": "codex-thread-1",
  "x-client-request-id": makeTurnId(),
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(metadata),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
  ...overrides,
});

/** Codex-style request body used to verify the mock provider's public contract. */
const requestBody = {
  model: "claude/test",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "ignored user prompt" }],
    },
  ],
  stream: true,
  tools: [],
  tool_choice: "auto",
  store: false,
  client_metadata: {
    thread_id: "codex-thread-1",
    turn_id: makeTurnId(),
  },
  metadata: {
    cwd: projectRoot,
  },
} as const satisfies Schema.Json;

/** Codex-style unsupported request body used to verify explicit hard failure. */
const nonStreamingRequestBody = {
  model: "claude/test",
  input: requestBody.input,
  stream: false,
  tools: [],
  tool_choice: "auto",
  store: false,
  client_metadata: requestBody.client_metadata,
  metadata: requestBody.metadata,
} as const satisfies Schema.Json;

/** Applies a stable set of Codex headers to one outgoing test request. */
const setCodexHeaders = ({
  request,
  headers = makeCodexHeaders(),
}: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly headers?: Readonly<Record<string, string>>;
}): HttpClientRequest.HttpClientRequest => {
  let nextRequest = request;
  for (const [name, value] of Object.entries(headers)) {
    nextRequest = nextRequest.pipe(HttpClientRequest.setHeader(name, value));
  }
  return nextRequest;
};

/** Builds a per-test logger layer that records logged inputs in insertion order. */
const makeCaptureLoggerLayer = (loggedInputs: Array<Schema.Json>) =>
  Layer.succeed(InputLogger, {
    logInput: Effect.fnUntraced(function* (input: Schema.Json) {
      yield* Effect.sync(() => {
        loggedInputs.push(input);
      });
    }),
  });

/** Builds a per-test diagnostics logger layer that records request diagnostics in order. */
const makeCaptureDiagnosticsLoggerLayer = (loggedDiagnostics: Array<ResponsesRequestDiagnostics>) =>
  Layer.succeed(RequestDiagnosticsLogger, {
    logRequest: Effect.fnUntraced(function* (diagnostics: ResponsesRequestDiagnostics) {
      yield* Effect.sync(() => {
        loggedDiagnostics.push(diagnostics);
      });
    }),
  });

/** Builds a per-test relay logger layer that records structured relay events in order. */
const makeCaptureRelayLoggerLayer = (relayEvents: Array<RelayLogEvent>) =>
  Layer.succeed(RelayLogger, {
    log: Effect.fnUntraced(function* (event: RelayLogEvent) {
      yield* Effect.sync(() => {
        relayEvents.push(event);
      });
    }),
  });

/** Builds the full scoped provider test layer for one test's captured logs. */
const makeProviderTestLayer = (
  loggedInputs: Array<Schema.Json>,
  loggedDiagnostics: Array<ResponsesRequestDiagnostics>,
  relayEvents: Array<RelayLogEvent>,
) => {
  const stateDir = path.join(projectRoot, "temp.local", `mock-provider-${randomUUID()}`);
  return mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(makeCaptureLoggerLayer(loggedInputs)),
    Layer.provideMerge(makeCaptureDiagnosticsLoggerLayer(loggedDiagnostics)),
    Layer.provideMerge(makeCaptureRelayLoggerLayer(relayEvents)),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(simulatorAgentDriverRegistryLive),
  );
};

/** Parsed Responses SSE frame decoded through Effect's OpenAI stream-event schema. */
interface ResponseSseFrame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: OpenAiSchema.ResponseStreamEvent;
}

/** Decodes OpenAI Responses SSE frames from the real response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Returns true when a value is a non-array object record. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads an object field after asserting that the parent is a record. */
const getField = (value: unknown, field: string): unknown => {
  assert.ok(isRecord(value), "value must be an object record");
  return value[field];
};

/** Finds the first SSE frame with the requested event name. */
const findFrame = (frames: readonly ResponseSseFrame[], event: string): ResponseSseFrame => {
  const frame = frames.find((candidate) => candidate.event === event);
  assert.ok(frame, `missing SSE event ${event}`);
  return frame;
};

/** Finds the completed assistant message SSE frame, skipping reasoning item completions. */
const findMessageDoneFrame = (frames: readonly ResponseSseFrame[]): ResponseSseFrame => {
  const frame = frames.find(
    (candidate) =>
      candidate.event === "response.output_item.done" && isAssistantMessageDoneData(candidate.data),
  );
  assert.ok(frame, "missing assistant message done event");
  return frame;
};

/** Extracts normalized runtime lifecycle tags from captured relay events. */
const runtimeEventTags = (events: readonly RelayLogEvent[]): readonly string[] =>
  events
    .filter((event) => event._tag === "RuntimeEventRelayed")
    .map((event) => event.runtimeEventTag);

/** Decodes and validates the expected reasoning delta event shape. */
const decodeReasoningDeltaEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("response.reasoning_summary_text.delta"),
    delta: Schema.String,
  }),
);

/** Decodes and validates the expected assistant message completion event shape. */
const decodeMessageDoneEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("response.output_item.done"),
    item: Schema.Struct({
      type: Schema.Literal("message"),
      content: Schema.Array(
        Schema.Struct({
          type: Schema.Literal("output_text"),
          text: Schema.String,
          annotations: Schema.Array(Schema.Unknown),
        }),
      ),
    }),
  }),
);

/** Decodes and validates the terminal response completion event shape. */
const decodeCompletedEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("response.completed"),
  }),
);

/** Test program for the happy-path streaming Responses contract. */
function streamsFakeReasoningAndFinalAnswer() {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];

  return Effect.gen(function* () {
    const request = setCodexHeaders({
      request: (yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/v1/responses?effort=max"),
        requestBody,
      )).pipe(HttpClientRequest.setHeader("Authorization", "Bearer diagnostic-test-secret")),
    });

    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    const reasoningData = decodeReasoningDeltaEvent(
      findFrame(frames, "response.reasoning_summary_text.delta").data,
    );
    const messageData = decodeMessageDoneEvent(findMessageDoneFrame(frames).data);
    const lastFrame = frames.at(-1);
    assert.ok(lastFrame, "SSE stream must include at least one frame");
    const completedData = decodeCompletedEvent(lastFrame.data);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers["content-type"], "text/event-stream");
    assert.deepStrictEqual(loggedInputs, [requestBody.input]);
    assert.strictEqual(loggedDiagnostics.length, 1);
    const diagnostics = loggedDiagnostics[0];
    assert.ok(diagnostics, "request diagnostics must be logged");
    assert.strictEqual(diagnostics.method, "POST");
    assert.strictEqual(diagnostics.url, "/v1/responses?effort=max");
    assert.strictEqual(diagnostics.headers["content-type"], "application/json");
    assert.strictEqual(diagnostics.headers.authorization, "[redacted]");
    assert.deepStrictEqual(diagnostics.body, requestBody);
    assert.deepStrictEqual(diagnostics.cwdCandidates, [projectRoot]);
    assert.strictEqual(reasoningData.delta, simulatorDriverFixture.reasoningText);
    assert.strictEqual(messageData.item.type, "message");
    assert.deepStrictEqual(messageData.item.content, [
      { type: "output_text", text: simulatorDriverFixture.assistantText, annotations: [] },
    ]);
    assert.notStrictEqual(simulatorDriverFixture.assistantText, mockResponsesFixture.assistantText);
    assert.strictEqual(completedData.type, "response.completed");
    assert.deepStrictEqual(
      relayEvents.slice(0, 4).map((event) => event._tag),
      ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted"],
    );
    assert.deepStrictEqual(runtimeEventTags(relayEvents), [
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
    ]);
    assert.strictEqual(relayEvents.at(-1)?._tag, "TurnCompleted");
    assert.deepStrictEqual(relayEvents[1], {
      _tag: "TargetSelected",
      externalAgentKind: "claude",
      externalModelSpecifier: "test",
      rawDriverOptions: {
        effort: "max",
      },
      requestedModel: "claude/test",
      threadId: "codex-thread-1",
      turnId: makeTurnId(),
    });
  }).pipe(Effect.provide(makeProviderTestLayer(loggedInputs, loggedDiagnostics, relayEvents)));
}

/** Test program for the unsupported non-streaming Responses request contract. */
function rejectsNonStreamingRequest() {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];

  return Effect.gen(function* () {
    const request = setCodexHeaders({
      request: (yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/v1/responses"),
        nonStreamingRequestBody,
      )).pipe(HttpClientRequest.setHeader("Authorization", "Bearer diagnostic-test-secret")),
    });

    const response = yield* HttpClient.execute(request);
    const body = yield* response.json;

    assert.strictEqual(response.status, 400);
    assert.deepStrictEqual(loggedInputs, []);
    assert.strictEqual(getField(getField(body, "error"), "type"), "invalid_request_error");
    assert.strictEqual(loggedDiagnostics.length, 1);
    const diagnostics = loggedDiagnostics[0];
    assert.ok(diagnostics, "request diagnostics must be logged before validation failure");
    assert.strictEqual(diagnostics.method, "POST");
    assert.strictEqual(diagnostics.url, "/v1/responses");
    assert.strictEqual(diagnostics.headers["content-type"], "application/json");
    assert.strictEqual(diagnostics.headers.authorization, "[redacted]");
    assert.deepStrictEqual(diagnostics.body, nonStreamingRequestBody);
    assert.deepStrictEqual(diagnostics.cwdCandidates, [projectRoot]);
    assert.deepStrictEqual(relayEvents, []);
  }).pipe(Effect.provide(makeProviderTestLayer(loggedInputs, loggedDiagnostics, relayEvents)));
}

/** Test program for OpenAI-shaped invalid request responses at the HTTP boundary. */
function rejectsInvalidCodexRequest({
  body,
  url = "/v1/responses",
  headers = makeCodexHeaders(),
  expectedMessage,
  expectedRelayTags = [],
}: {
  readonly body: Schema.Json;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expectedMessage: RegExp;
  readonly expectedRelayTags?: readonly string[];
}) {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];

  return Effect.gen(function* () {
    const request = setCodexHeaders({
      request: yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url), body),
      headers,
    });
    const response = yield* HttpClient.execute(request);
    const responseBody = yield* response.json;

    assert.strictEqual(response.status, 400);
    assert.deepStrictEqual(loggedInputs, []);
    assert.strictEqual(getField(getField(responseBody, "error"), "type"), "invalid_request_error");
    assert.match(String(getField(getField(responseBody, "error"), "message")), expectedMessage);
    assert.strictEqual(loggedDiagnostics.length, 1);
    assert.deepStrictEqual(
      relayEvents.map((event) => event._tag),
      expectedRelayTags,
    );
  }).pipe(Effect.provide(makeProviderTestLayer(loggedInputs, loggedDiagnostics, relayEvents)));
}

/** Test program for simulator driver failure visibility through relay logs. */
function logsSimulatorDriverFailures() {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];

  return Effect.gen(function* () {
    const request = setCodexHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/v1/responses?simulator_failure=start"),
        requestBody,
      ),
    });
    const response = yield* HttpClient.execute(request);
    const responseBody = yield* response.json;

    assert.strictEqual(response.status, 500);
    assert.strictEqual(getField(getField(responseBody, "error"), "type"), "server_error");
    assert.match(String(getField(getField(responseBody, "error"), "message")), /simulator/i);
    assert.deepStrictEqual(
      relayEvents.map((event) => event._tag),
      ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted", "TurnFailed"],
    );
    assert.deepStrictEqual(relayEvents.at(-1), {
      _tag: "TurnFailed",
      threadId: "codex-thread-1",
      turnId: makeTurnId(),
      message: simulatorDriverFixture.startFailureMessage,
    });
    assert.deepStrictEqual(loggedInputs, []);
    assert.strictEqual(loggedDiagnostics.length, 1);
  }).pipe(Effect.provide(makeProviderTestLayer(loggedInputs, loggedDiagnostics, relayEvents)));
}

describe("mock Responses provider", () => {
  it.effect(
    "streams fake reasoning and final answer while logging input",
    streamsFakeReasoningAndFinalAnswer,
  );

  it.effect("rejects non-streaming requests without logging input", rejectsNonStreamingRequest);

  it.effect("rejects malformed model strings with an OpenAI-shaped error", () =>
    rejectsInvalidCodexRequest({
      body: {
        ...requestBody,
        model: "claude",
      },
      expectedMessage: /model/i,
    }),
  );

  it.effect("rejects duplicate provider query params with an OpenAI-shaped error", () =>
    rejectsInvalidCodexRequest({
      body: requestBody,
      url: "/v1/responses?effort=max&effort=low",
      expectedMessage: /duplicate provider query param/i,
    }),
  );

  it.effect("rejects malformed turn metadata with an OpenAI-shaped error", () =>
    rejectsInvalidCodexRequest({
      body: requestBody,
      headers: makeCodexHeaders({
        overrides: {
          "x-codex-turn-metadata": "{not-json",
        },
      }),
      expectedMessage: /turn metadata/i,
    }),
  );

  it.effect("rejects conflicting identity fields with an OpenAI-shaped error", () =>
    rejectsInvalidCodexRequest({
      body: requestBody,
      headers: makeCodexHeaders({
        overrides: {
          "thread-id": "different-thread",
        },
      }),
      expectedMessage: /conflict/i,
    }),
  );

  it.effect("rejects missing cwd for a new binding with an OpenAI-shaped error", () =>
    rejectsInvalidCodexRequest({
      body: {
        ...requestBody,
        metadata: {},
      },
      headers: makeCodexHeaders({
        metadata: makeTurnMetadata({ workspaces: {} }),
      }),
      expectedMessage: /cwd/i,
      expectedRelayTags: ["TurnAccepted", "TargetSelected"],
    }),
  );

  it.effect("logs simulator driver failures with an OpenAI-shaped transport error", () =>
    logsSimulatorDriverFailures(),
  );
});
