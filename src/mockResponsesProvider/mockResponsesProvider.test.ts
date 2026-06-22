import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "./inputLogger.ts";
import { mockResponsesFixture } from "./protocol.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./server.ts";

/** Codex-style request body used to verify the mock provider's public contract. */
const requestBody = {
  model: "fake-model",
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
  metadata: {
    cwd: "/Volumes/Projects/Software/code-agents-as-responses-api",
  },
} as const satisfies Schema.Json;

/** Codex-style unsupported request body used to verify explicit hard failure. */
const nonStreamingRequestBody = {
  model: "fake-model",
  input: requestBody.input,
  stream: false,
  tools: [],
  tool_choice: "auto",
  store: false,
} as const satisfies Schema.Json;

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

/** Builds the full scoped provider test layer for one test's captured logs. */
const makeProviderTestLayer = (
  loggedInputs: Array<Schema.Json>,
  loggedDiagnostics: Array<ResponsesRequestDiagnostics>,
) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(makeCaptureLoggerLayer(loggedInputs)),
    Layer.provideMerge(makeCaptureDiagnosticsLoggerLayer(loggedDiagnostics)),
  );

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

  return Effect.gen(function* () {
    const request = (yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post("/v1/responses"),
      requestBody,
    )).pipe(HttpClientRequest.setHeader("Authorization", "Bearer diagnostic-test-secret"));

    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    const reasoningData = decodeReasoningDeltaEvent(
      findFrame(frames, "response.reasoning_summary_text.delta").data,
    );
    const messageData = decodeMessageDoneEvent(findFrame(frames, "response.output_item.done").data);
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
    assert.strictEqual(diagnostics.url, "/v1/responses");
    assert.strictEqual(diagnostics.headers["content-type"], "application/json");
    assert.strictEqual(diagnostics.headers.authorization, "[redacted]");
    assert.deepStrictEqual(diagnostics.body, requestBody);
    assert.deepStrictEqual(diagnostics.cwdCandidates, [
      "/Volumes/Projects/Software/code-agents-as-responses-api",
    ]);
    assert.strictEqual(reasoningData.delta, mockResponsesFixture.reasoningText);
    assert.strictEqual(messageData.item.type, "message");
    assert.deepStrictEqual(messageData.item.content, [
      { type: "output_text", text: mockResponsesFixture.assistantText, annotations: [] },
    ]);
    assert.strictEqual(completedData.type, "response.completed");
  }).pipe(Effect.provide(makeProviderTestLayer(loggedInputs, loggedDiagnostics)));
}

/** Test program for the unsupported non-streaming Responses request contract. */
function rejectsNonStreamingRequest() {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];

  return Effect.gen(function* () {
    const request = (yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post("/v1/responses"),
      nonStreamingRequestBody,
    )).pipe(HttpClientRequest.setHeader("Authorization", "Bearer diagnostic-test-secret"));

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
    assert.deepStrictEqual(diagnostics.cwdCandidates, []);
  }).pipe(Effect.provide(makeProviderTestLayer(loggedInputs, loggedDiagnostics)));
}

describe("mock Responses provider", () => {
  it.effect(
    "streams fake reasoning and final answer while logging input",
    streamsFakeReasoningAndFinalAnswer,
  );

  it.effect("rejects non-streaming requests without logging input", rejectsNonStreamingRequest);
});
