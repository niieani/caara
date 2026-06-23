import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { diagnosticAgentDriverRegistryLive } from "./diagnosticDriver.ts";
import { InputLogger } from "./inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { assistantTextFromResponseFrames } from "./responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Project root used as the Codex workspace path in diagnostic echo tests. */
const projectRoot = process.cwd();

/** Stable Codex thread id used to prove diagnostic echo binding reuse. */
const makeThreadId = (): string => "codex-thread-diagnostic-echo";

/** Test fixture failure for diagnostic echo provider setup. */
class DiagnosticDriverEchoTestError extends Schema.TaggedErrorClass<DiagnosticDriverEchoTestError>()(
  "DiagnosticDriverEchoTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged diagnostic echo test error. */
const diagnosticDriverEchoTestError = (cause: unknown): DiagnosticDriverEchoTestError =>
  new DiagnosticDriverEchoTestError({ message: String(cause) });

/** Builds Codex turn metadata for one diagnostic echo provider request. */
const makeTurnMetadata = (turnId: string): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-diagnostic-echo",
  session_id: "parent-session-diagnostic-echo",
  thread_id: makeThreadId(),
  turn_id: turnId,
  window_id: "window-diagnostic-echo",
  request_kind: "turn",
  parent_thread_id: "parent-thread-diagnostic-echo",
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

/** Builds complete Codex headers for one diagnostic echo provider request. */
const makeHeaders = (turnId: string): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-diagnostic-echo",
  "thread-id": makeThreadId(),
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-diagnostic-echo",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata(turnId),
  ),
  "x-codex-window-id": "window-diagnostic-echo",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for diagnostic/echo. */
const makeBody = ({
  turnId,
  input,
}: {
  readonly turnId: string;
  readonly input: Schema.Json;
}): Schema.Json => ({
  model: "diagnostic/echo",
  input,
  stream: true,
  client_metadata: {
    thread_id: makeThreadId(),
    turn_id: turnId,
  },
  metadata: { cwd: projectRoot },
});

/** Builds a Responses user message item with a single text content block. */
const userTextMessage = (text: string): Schema.Json => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

/** Builds the developer message that Codex Desktop sends before workspace user context. */
const developerMessage = (): Schema.Json => ({
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "Use Codex developer instructions." }],
});

/** Builds the AGENTS/environment prelude user message observed in real Codex subagent input. */
const codexPreludeMessage = (): Schema.Json => ({
  type: "message",
  role: "user",
  content: [
    {
      type: "input_text",
      text: "# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>\nUse Bun.\n</INSTRUCTIONS>",
    },
    {
      type: "input_text",
      text: "<environment_context>\n  <cwd>/workspace/project</cwd>\n</environment_context>",
    },
  ],
});

/** Builds a prior assistant message that must never appear in diagnostic/echo output. */
const priorAssistantMessage = (): Schema.Json => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "previous assistant output" }],
});

/** Builds a prior tool output item that must never appear in diagnostic/echo output. */
const priorToolOutput = (): Schema.Json => ({
  type: "function_call_output",
  call_id: "call_previous",
  output: "previous tool output",
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

/** Decodes Responses SSE frames from a response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Creates a fresh state directory under project-local temp.local. */
const makeStateDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: diagnosticDriverEchoTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `diagnostic-echo-${randomUUID()}-`)),
    catch: diagnosticDriverEchoTestError,
  });
});

/** Runs one diagnostic/echo turn through the provider boundary. */
const runDiagnosticEchoTurn = ({
  stateDir,
  turnId,
  input,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly input: Schema.Json;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/v1/responses"),
        makeBody({ turnId, input }),
      ),
      headers: makeHeaders(turnId),
    });
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    assert.strictEqual(response.status, 200);
    return { frames, assistantText: assistantTextFromResponseFrames(frames) };
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Runs one diagnostic/echo turn expected to fail before a Responses stream starts. */
const runDiagnosticEchoErrorTurn = ({
  stateDir,
  turnId,
  input,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly input: Schema.Json;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/v1/responses"),
        makeBody({ turnId, input }),
      ),
      headers: makeHeaders(turnId),
    });
    const response = yield* HttpClient.execute(request);
    const body = yield* response.json;
    return { status: response.status, body };
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Returns an object field after asserting the value is an object record. */
const objectField = (value: unknown, field: string): unknown => {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return (value as Readonly<Record<string, unknown>>)[field];
};

describe("diagnostic echo driver", () => {
  it.effect("echoes first-turn current user input deterministically", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const result = yield* runDiagnosticEchoTurn({
        stateDir,
        turnId: "turn-diagnostic-echo-1",
        input: [userTextMessage("first echo request")],
        inputs,
        diagnostics,
        relayEvents,
      });

      assert.strictEqual(
        result.assistantText,
        'Diagnostic echo current user input: [{"type":"input_text","text":"first echo request"}]',
      );
      assert.strictEqual(inputs.length, 1);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(relayEvents.at(-1)?._tag, "TurnCompleted");
    }),
  );

  it.effect("normalizes real Codex prelude before diagnostic driver dispatch", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const result = yield* runDiagnosticEchoTurn({
        stateDir,
        turnId: "turn-diagnostic-echo-codex-prelude",
        input: [
          developerMessage(),
          codexPreludeMessage(),
          userTextMessage("Read README.md line 5."),
        ],
        inputs,
        diagnostics,
        relayEvents,
      });

      assert.strictEqual(
        result.assistantText,
        'Diagnostic echo current user input: [{"type":"input_text","text":"Read README.md line 5."}]',
      );
      assert.strictEqual(result.assistantText.includes("Use Codex developer instructions"), false);
      assert.strictEqual(result.assistantText.includes("AGENTS.md instructions"), false);
      assert.strictEqual(result.assistantText.includes("<environment_context>"), false);
      assert.deepStrictEqual(inputs, [
        [developerMessage(), codexPreludeMessage(), userTextMessage("Read README.md line 5.")],
      ]);
      assert.deepStrictEqual(
        relayEvents.slice(0, 4).map((event) => event._tag),
        ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted"],
      );
      assert.strictEqual(relayEvents.at(-1)?._tag, "TurnCompleted");
    }),
  );

  it.effect("normalizes follow-up history before diagnostic driver dispatch", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      yield* runDiagnosticEchoTurn({
        stateDir,
        turnId: "turn-diagnostic-echo-history-1",
        input: [userTextMessage("first request")],
        inputs,
        diagnostics,
        relayEvents,
      });
      const followUp = yield* runDiagnosticEchoTurn({
        stateDir,
        turnId: "turn-diagnostic-echo-history-2",
        input: [
          userTextMessage("first request"),
          priorAssistantMessage(),
          priorToolOutput(),
          userTextMessage("current request"),
        ],
        inputs,
        diagnostics,
        relayEvents,
      });

      assert.strictEqual(
        followUp.assistantText,
        'Diagnostic echo current user input: [{"type":"input_text","text":"current request"}]',
      );
      assert.strictEqual(followUp.assistantText.includes("previous assistant output"), false);
      assert.strictEqual(followUp.assistantText.includes("previous tool output"), false);
      assert.strictEqual(inputs.length, 2);
      assert.strictEqual(diagnostics.length, 2);
    }),
  );

  it.effect("fails explicitly for unsupported current-turn content", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];
      const failure = yield* runDiagnosticEchoErrorTurn({
        stateDir,
        turnId: "turn-diagnostic-echo-invalid",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_audio", audio_url: "file://unsupported.wav" }],
          },
        ],
        inputs,
        diagnostics,
        relayEvents,
      });

      assert.strictEqual(failure.status, 500);
      assert.match(
        String(objectField(objectField(failure.body, "error"), "message")),
        /unsupported diagnostic echo current-turn content/i,
      );
      assert.deepStrictEqual(inputs, []);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(relayEvents.at(-1)?._tag, "TurnFailed");
    }),
  );
});
