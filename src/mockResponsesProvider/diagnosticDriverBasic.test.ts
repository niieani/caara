import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
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
import { assistantTextFromResponseFrames } from "./responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { sessionBindingFilePath } from "./sessionDirectoryPlatform.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Project root used as the Codex workspace path in diagnostic driver tests. */
const projectRoot = process.cwd();

/** Stable Codex thread id used to prove diagnostic binding reuse. */
const makeThreadId = (): string => "codex-thread-diagnostic-basic";

/** Test fixture failure for diagnostic provider setup and persisted binding inspection. */
class DiagnosticDriverBasicTestError extends Schema.TaggedErrorClass<DiagnosticDriverBasicTestError>()(
  "DiagnosticDriverBasicTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged diagnostic test error. */
const diagnosticDriverBasicTestError = (cause: unknown): DiagnosticDriverBasicTestError =>
  new DiagnosticDriverBasicTestError({ message: String(cause) });

/** Builds Codex turn metadata for one diagnostic provider request. */
const makeTurnMetadata = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-diagnostic-basic",
  session_id: "parent-session-diagnostic-basic",
  thread_id: makeThreadId(),
  turn_id: turnId,
  window_id: "window-diagnostic-basic",
  request_kind: "turn",
  parent_thread_id: "parent-thread-diagnostic-basic",
  subagent_kind: "caara",
  sandbox: "workspace-write",
  workspaces: Object.fromEntries(
    [projectRoot]
      .filter(() => includeWorkspace)
      .map((workspacePath) => [
        workspacePath,
        {
          latest_git_commit_hash: "abcdef0",
          has_changes: true,
        },
      ]),
  ),
  turn_started_at_unix_ms: 1,
});

/** Builds complete Codex headers for one diagnostic provider request. */
const makeHeaders = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-diagnostic-basic",
  "thread-id": makeThreadId(),
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-diagnostic-basic",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ turnId, includeWorkspace }),
  ),
  "x-codex-window-id": "window-diagnostic-basic",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for one diagnostic turn. */
const makeBody = ({
  turnId,
  includeCwd,
}: {
  readonly turnId: string;
  readonly includeCwd: boolean;
}): Schema.Json => ({
  model: "diagnostic/basic",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `turn ${turnId}` }],
    },
  ],
  stream: true,
  client_metadata: {
    thread_id: makeThreadId(),
    turn_id: turnId,
  },
  metadata: Object.fromEntries([projectRoot].filter(() => includeCwd).map((cwd) => ["cwd", cwd])),
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
    catch: diagnosticDriverBasicTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `diagnostic-basic-${randomUUID()}-`)),
    catch: diagnosticDriverBasicTestError,
  });
});

/** Reads the persisted diagnostic binding JSON for this test's Codex thread. */
const readPersistedBinding = ({ stateDir }: { readonly stateDir: string }) =>
  Effect.tryPromise({
    try: () =>
      fs.readFile(
        sessionBindingFilePath({
          stateDir,
          externalAgentKind: "diagnostic",
          driverInstanceId: "diagnostic",
          codexThreadId: makeThreadId(),
        }),
        "utf8",
      ),
    catch: diagnosticDriverBasicTestError,
  }).pipe(Effect.map((content) => Schema.decodeSync(Schema.UnknownFromJsonString)(content)));

/** Runs one diagnostic/basic turn through the provider boundary. */
const runDiagnosticTurn = ({
  stateDir,
  turnId,
  url,
  includeWorkspace,
  includeCwd,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly url: string;
  readonly includeWorkspace: boolean;
  readonly includeCwd: boolean;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(url),
        makeBody({ turnId, includeCwd }),
      ),
      headers: makeHeaders({ turnId, includeWorkspace }),
    });
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    assert.strictEqual(response.status, 200);
    return { frames, assistantText: assistantTextFromResponseFrames(frames) };
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Runs one diagnostic/basic turn expected to fail before a Responses stream starts. */
const runDiagnosticErrorTurn = ({
  stateDir,
  turnId,
  url,
  includeWorkspace,
  includeCwd,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly url: string;
  readonly includeWorkspace: boolean;
  readonly includeCwd: boolean;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(url),
        makeBody({ turnId, includeCwd }),
      ),
      headers: makeHeaders({ turnId, includeWorkspace }),
    });
    const response = yield* HttpClient.execute(request);
    const body = yield* response.json;
    return { status: response.status, body };
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Schema used to narrow assistant output delta stream events. */
const OutputTextDeltaData = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  delta: Schema.String,
});

/** Returns whether one Responses event is an assistant output delta. */
const isOutputTextDeltaData = Schema.is(OutputTextDeltaData);

/** Extracts assistant output deltas from decoded Responses SSE frames. */
const assistantDeltas = (frames: readonly { readonly data: OpenAiSchema.ResponseStreamEvent }[]) =>
  frames
    .map((frame) => frame.data)
    .filter(isOutputTextDeltaData)
    .map((data) => data.delta);

/** Returns an object field after asserting the value is an object record. */
const objectField = (value: unknown, field: string): unknown => {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return (value as Readonly<Record<string, unknown>>)[field];
};

describe("diagnostic basic driver", () => {
  it.effect("routes diagnostic/basic through the provider and resumes its binding", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const first = yield* runDiagnosticTurn({
        stateDir,
        turnId: "turn-diagnostic-basic-1",
        url: "/v1/responses?diagnostic_answer_text=custom%20diagnostic%20answer&diagnostic_chunk_count=3&diagnostic_delay_ms=0",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });
      const firstBinding = yield* readPersistedBinding({ stateDir });
      const second = yield* runDiagnosticTurn({
        stateDir,
        turnId: "turn-diagnostic-basic-2",
        url: "/v1/responses",
        includeWorkspace: false,
        includeCwd: false,
        inputs,
        diagnostics,
        relayEvents,
      });
      const secondBinding = yield* readPersistedBinding({ stateDir });

      const firstDeltas = assistantDeltas(first.frames);
      assert.strictEqual(first.assistantText, "custom diagnostic answer");
      assert.strictEqual(firstDeltas.length, 3);
      assert.strictEqual(firstDeltas.join(""), "custom diagnostic answer");
      assert.strictEqual(second.assistantText, diagnosticDriverFixture.resumedBasicAnswerText);
      assert.strictEqual(
        objectField(objectField(firstBinding, "externalSession"), "driverResumeCursor"),
        diagnosticDriverFixture.basicExternalSessionCursor,
      );
      assert.strictEqual(
        objectField(objectField(secondBinding, "externalSession"), "driverResumeCursor"),
        diagnosticDriverFixture.basicExternalSessionCursor,
      );
      assert.deepStrictEqual(
        objectField(objectField(firstBinding, "bindingKey"), "externalAgentKind"),
        "diagnostic",
      );
      assert.deepStrictEqual(
        objectField(objectField(firstBinding, "bindingKey"), "driverInstanceId"),
        "diagnostic",
      );
      assert.deepStrictEqual(
        relayEvents
          .filter((event) => event._tag === "TargetSelected")
          .map((event) => [event.externalAgentKind, event.externalModelSpecifier]),
        [
          ["diagnostic", "basic"],
          ["diagnostic", "basic"],
        ],
      );
      assert.deepStrictEqual(
        relayEvents
          .filter((event) => event._tag === "DriverStarted")
          .map((event) => event.previousTarget),
        [
          undefined,
          {
            requestedModel: "diagnostic/basic",
            externalAgentKind: "diagnostic",
            externalModelSpecifier: "basic",
            rawDriverOptions: {
              diagnostic_answer_text: "custom diagnostic answer",
              diagnostic_chunk_count: "3",
              diagnostic_delay_ms: "0",
            },
          },
        ],
      );
      assert.strictEqual(inputs.length, 2);
      assert.strictEqual(diagnostics.length, 2);
    }),
  );

  it.effect("rejects unsupported diagnostic scenarios and options explicitly", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];
      const failure = yield* runDiagnosticErrorTurn({
        stateDir,
        turnId: "turn-diagnostic-basic-invalid",
        url: "/v1/responses?diagnostic_script=%7B%7D",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });

      assert.strictEqual(failure.status, 500);
      assert.match(
        String(objectField(objectField(failure.body, "error"), "message")),
        /unsupported diagnostic driver option/i,
      );
      assert.deepStrictEqual(inputs, []);
      assert.strictEqual(diagnostics.length, 1);
      assert.deepStrictEqual(
        relayEvents.map((event) => event._tag),
        ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted", "TurnFailed"],
      );
    }),
  );
});
