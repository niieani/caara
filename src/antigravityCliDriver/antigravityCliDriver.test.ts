import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Match, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { CaaraSettings, defaultCaaraSettingsValue } from "../caaraSettings.ts";
import type { CodexAdvisoryEffort } from "../mockResponsesProvider/codexTurnContext.ts";
import { InputLogger } from "../mockResponsesProvider/inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "../mockResponsesProvider/relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "../mockResponsesProvider/requestDiagnosticsLogger.ts";
import {
  assistantTextFromResponseFrames,
  failedErrorCodeFromResponseFrames,
  failedErrorMessageFromResponseFrames,
  isAssistantMessageDoneData,
  type ResponseFrameWithData,
} from "../mockResponsesProvider/responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "../mockResponsesProvider/server.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { sessionBindingFilePath } from "../mockResponsesProvider/sessionDirectoryPlatform.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { antigravityCliDriverLayer } from "./driver.ts";
import { fakeAgyFixture, fakeAgyScript } from "./fakeAgyScript.ts";
import { AntigravityCliSettings } from "./settings.ts";
import { antigravityMissingFinalDiagnosticText } from "./transcriptRuntimeEvents.ts";

/** Project root used as the Codex workspace path in Antigravity driver tests. */
const projectRoot = process.cwd();

/** Test fixture failure for setup and persisted binding inspection. */
class AntigravityCliDriverTestError extends Schema.TaggedErrorClass<AntigravityCliDriverTestError>()(
  "AntigravityCliDriverTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged test error. */
const testError = (cause: unknown): AntigravityCliDriverTestError =>
  new AntigravityCliDriverTestError({ message: String(cause) });

/** Captured fake `agy` process invocation. */
const FakeAgyInvocation = Schema.Struct({
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  prompt: Schema.String,
});

/** Builds Codex turn metadata for an Antigravity test turn. */
const makeTurnMetadata = ({
  turnId,
}: {
  readonly turnId: string;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: "codex-thread-agy",
  turn_id: turnId,
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
});

/** Builds Codex headers for one Antigravity test turn. */
const makeHeaders = ({
  turnId,
}: {
  readonly turnId: string;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": "codex-thread-agy",
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ turnId }),
  ),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for one Antigravity turn. */
const makeBody = ({
  turnId,
  input = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `turn ${turnId}` }],
    },
  ],
  advisoryEffort,
}: {
  readonly turnId: string;
  readonly input?: Schema.Json;
  readonly advisoryEffort?: CodexAdvisoryEffort;
}): Schema.Json => ({
  model: "agy/gemini-3.5-flash",
  input,
  stream: true,
  ...Match.value(advisoryEffort).pipe(
    Match.when(undefined, () => ({})),
    Match.orElse((effort) => ({ reasoning: { effort } })),
  ),
  client_metadata: {
    thread_id: "codex-thread-agy",
    turn_id: turnId,
  },
  metadata: {
    cwd: projectRoot,
  },
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

/** Builds one current managing-agent user request message. */
const currentUserMessage = (text: string): Schema.Json => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

/** Applies the Codex header fixture to a test HTTP request. */
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

/** Returns true when a decoded Responses stream contains a terminal failure frame. */
const hasResponseFailureFrame = (
  frames: readonly { readonly event: string; readonly data: unknown }[],
): boolean => frames.some((frame) => frame.event === "response.failed");

/** Returns driver failure messages captured by the provider relay logger. */
const turnFailedMessages = (events: readonly RelayLogEvent[]): readonly string[] =>
  turnFailedEvents(events).map((event) => event.message);

/** Returns driver failure relay events captured by the provider relay logger. */
const turnFailedEvents = (
  events: readonly RelayLogEvent[],
): readonly Extract<RelayLogEvent, { readonly _tag: "TurnFailed" }>[] =>
  events.filter(
    (event): event is Extract<RelayLogEvent, { readonly _tag: "TurnFailed" }> =>
      event._tag === "TurnFailed",
  );

/** Returns decoded SSE event names in order. */
const frameEventNames = (
  frames: readonly Pick<ResponseFrameWithData, "event">[],
): readonly string[] => frames.map((frame) => frame.event);

/** Returns assistant message completion frames from decoded Responses SSE frames. */
const assistantMessageDoneFrames = (
  frames: readonly ResponseFrameWithData[],
): readonly ResponseFrameWithData[] =>
  frames.filter(
    (frame) =>
      frame.event === "response.output_item.done" && isAssistantMessageDoneData(frame.data),
  );

/** Decoded Responses SSE frames accepted by the test assistant-text extractor. */
type DecodedResponseFrames = Parameters<typeof assistantTextFromResponseFrames>[0];

/** Converts decoded 200 response frames into the provider-boundary test result shape. */
const successfulHttpTurnResult = ({
  frames,
  status,
}: {
  readonly frames: DecodedResponseFrames;
  readonly status: number;
}) =>
  Match.value(hasResponseFailureFrame(frames)).pipe(
    Match.when(true, () => ({
      _tag: "StreamFailure" as const,
      status,
    })),
    Match.orElse(() => ({
      _tag: "Success" as const,
      text: assistantTextFromResponseFrames(frames),
    })),
  );

/** Builds a fresh server layer backed by the fake Antigravity CLI process. */
const providerLayer = ({
  stateDir,
  fakeAgyPath,
  fakeHomeDir,
  invocationLogPath,
  fakeMode,
  environment,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
  readonly fakeMode: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(inputLoggerLayer([])),
    Layer.provideMerge(diagnosticsLoggerLayer([])),
    Layer.provideMerge(relayLoggerLayer(relayEvents)),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(antigravityCliDriverLayer),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(
      Layer.succeed(AntigravityCliSettings, {
        command: fakeAgyPath,
        homeDir: fakeHomeDir,
        environment: environment ?? {
          AGY_FAKE_INVOCATION_LOG: invocationLogPath,
          AGY_FAKE_MODE: fakeMode,
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CaaraSettings, {
        ...defaultCaaraSettingsValue,
        allowDangerousSkipPermissions: fakeMode === "trusted-skip-permissions",
      }),
    ),
  );

/** Decodes Responses SSE frames from a response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Decodes raw Responses SSE frames without dropping failure response fields. */
const decodeUnknownResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Executes one Antigravity HTTP turn without owning the provider layer lifetime. */
const executeTurnRequest = Effect.fnUntraced(function* ({
  turnId,
  queryString,
  input,
  advisoryEffort,
}: {
  readonly turnId: string;
  readonly queryString?: string;
  readonly input?: Schema.Json;
  readonly advisoryEffort?: CodexAdvisoryEffort;
}) {
  const url = `/v1/responses${queryString ?? ""}`;
  const request = setHeaders({
    request: yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(url),
      makeBody({ turnId, input, advisoryEffort }),
    ),
    headers: makeHeaders({ turnId }),
  });
  return yield* HttpClient.execute(request);
});

/** Executes one Antigravity HTTP turn and returns raw SSE frames plus response metadata. */
const executeTurnRawFrames = Effect.fnUntraced(function* ({
  turnId,
  queryString,
  input,
  advisoryEffort,
}: {
  readonly turnId: string;
  readonly queryString?: string;
  readonly input?: Schema.Json;
  readonly advisoryEffort?: CodexAdvisoryEffort;
}) {
  const response = yield* executeTurnRequest({ turnId, queryString, input, advisoryEffort });
  const frames = yield* decodeUnknownResponseSseFrames(response.stream);
  return {
    frames,
    status: response.status,
    contentType: response.headers["content-type"],
  };
});

/** Runs one HTTP turn through a provider layer configured for one fake Antigravity mode. */
const runTurn = ({
  stateDir,
  fakeAgyPath,
  fakeHomeDir,
  invocationLogPath,
  fakeMode,
  queryString,
  input,
  advisoryEffort,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
  readonly fakeMode: string;
  readonly queryString?: string;
  readonly input?: Schema.Json;
  readonly advisoryEffort?: CodexAdvisoryEffort;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const response = yield* executeTurnRequest({
      turnId: "turn-1",
      queryString,
      input,
      advisoryEffort,
    });
    const success = decodeResponseSseFrames(response.stream).pipe(
      Effect.map((frames) => successfulHttpTurnResult({ frames, status: response.status })),
    );
    const failure = response.text.pipe(
      Effect.map((body) => ({
        _tag: "Failure" as const,
        status: response.status,
        body,
      })),
    );
    return yield* Match.value(response.status).pipe(
      Match.when(200, () => success),
      Match.orElse(() => failure),
    );
  }).pipe(
    Effect.provide(
      providerLayer({
        stateDir,
        fakeAgyPath,
        fakeHomeDir,
        invocationLogPath,
        fakeMode,
        relayEvents,
      }),
    ),
  );

/** Creates a fresh project-local fixture directory for one Antigravity test. */
const makeFixture = Effect.fnUntraced(function* () {
  const tempRoot = path.join(
    projectRoot,
    "temp.local",
    "2026-06-23",
    "antigravity-cli-driver-tests",
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: testError,
  });
  const root = yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `fixture-${randomUUID()}-`)),
    catch: testError,
  });
  const fakeHomeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const fakeAgyPath = path.join(binDir, "agy");
  const invocationLogPath = path.join(root, "invocations.jsonl");
  const stateDir = path.join(root, "state");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(binDir, { recursive: true }),
    catch: testError,
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(fakeAgyPath, fakeAgyScript, { mode: 0o755 }),
    catch: testError,
  });
  return { fakeAgyPath, fakeHomeDir, invocationLogPath, stateDir };
});

/** Reads the first fake `agy` invocation recorded by the fixture executable. */
const readFakeInvocation = Effect.fnUntraced(function* ({
  invocationLogPath,
}: {
  readonly invocationLogPath: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(invocationLogPath, "utf8"),
    catch: testError,
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(FakeAgyInvocation))(content.trim());
});

/** Reads the persisted binding JSON for the Antigravity test session key. */
const readPersistedBinding = Effect.fnUntraced(function* ({
  stateDir,
}: {
  readonly stateDir: string;
}) {
  const bindingPath = persistedAntigravityBindingPath({ stateDir });
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(bindingPath, "utf8"),
    catch: testError,
  });
  return yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(content);
});

/** Returns the persisted Antigravity binding path for the driver test session key. */
const persistedAntigravityBindingPath = ({ stateDir }: { readonly stateDir: string }): string =>
  sessionBindingFilePath({
    stateDir,
    externalAgentKind: "agy",
    driverInstanceId: "agy",
    codexThreadId: "codex-thread-agy",
  });

/** Returns whether an Antigravity binding exists for the driver test session key. */
const antigravityBindingExists = Effect.fnUntraced(function* ({
  stateDir,
}: {
  readonly stateDir: string;
}) {
  return yield* Effect.tryPromise({
    try: () => Bun.file(persistedAntigravityBindingPath({ stateDir })).exists(),
    catch: testError,
  });
});

/** Decodes a persisted Antigravity binding into the cursor assertion shape. */
const PersistedAntigravityBinding = Schema.Struct({
  externalSession: Schema.TaggedStruct("Durable", {
    driverResumeCursor: Schema.fromJsonString(
      Schema.Struct({
        schemaVersion: Schema.Literal(1),
        conversationId: Schema.String,
      }),
    ),
  }),
});

/** Exercises an accepted Antigravity process failure followed by same-provider recovery. */
const assertAntigravityProcessFailureThenRecovery = Effect.fnUntraced(function* ({
  stateDir,
  environment,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly environment: Record<string, string>;
  readonly relayEvents: readonly RelayLogEvent[];
}) {
  const failed = yield* executeTurnRawFrames({
    turnId: "turn-antigravity-process-failure",
  });

  assert.strictEqual(failed.status, 200);
  assert.strictEqual(failed.contentType, "text/event-stream");
  assert.deepStrictEqual(frameEventNames(failed.frames), ["response.created", "response.failed"]);
  assert.strictEqual(
    failedErrorMessageFromResponseFrames(failed.frames),
    "Caara driver failed: Antigravity CLI exited with code 23.",
  );
  assert.deepStrictEqual(assistantMessageDoneFrames(failed.frames), []);
  assert.strictEqual(frameEventNames(failed.frames).includes("response.completed"), false);
  assert.deepStrictEqual(turnFailedEvents(relayEvents), [
    {
      _tag: "TurnFailed",
      threadId: "codex-thread-agy",
      turnId: "turn-antigravity-process-failure",
      message: "Antigravity CLI exited with code 23.",
    },
  ]);
  assert.strictEqual(yield* antigravityBindingExists({ stateDir }), false);

  environment.AGY_FAKE_MODE = "success";
  const recovered = yield* executeTurnRawFrames({
    turnId: "turn-antigravity-after-process-failure",
  });
  assert.strictEqual(recovered.status, 200);
  assert.strictEqual(assistantTextFromResponseFrames(recovered.frames), fakeAgyFixture.finalAnswer);
});

describe("Antigravity CLI driver", () => {
  it.effect("drives a first turn through a fake agy executable and persists an opaque cursor", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const relayEvents: Array<RelayLogEvent> = [];
      const result = yield* runTurn({ ...fixture, fakeMode: "success", relayEvents });

      assert.deepStrictEqual(result, { _tag: "Success", text: fakeAgyFixture.finalAnswer });

      const invocation = yield* readFakeInvocation({
        invocationLogPath: fixture.invocationLogPath,
      });
      assert.deepStrictEqual(invocation.args.slice(0, 2), ["--prompt", "turn turn-1"]);
      assert.ok(!invocation.args.includes("--print"));
      assert.deepStrictEqual(invocation.args.slice(2, 4), ["--model", "Gemini 3.5 Flash (Medium)"]);
      assert.deepStrictEqual(invocation.args.slice(4, 6), ["--print-timeout", "7200s"]);
      assert.ok(invocation.args.includes("--log-file"));
      assert.strictEqual(invocation.cwd, projectRoot);

      const binding = yield* readPersistedBinding({ stateDir: fixture.stateDir });
      const decoded = yield* Schema.decodeUnknownEffect(PersistedAntigravityBinding)(binding);
      assert.strictEqual(
        decoded.externalSession.driverResumeCursor.conversationId,
        fakeAgyFixture.conversationId,
      );
    }),
  );

  it.effect("passes only normalized current-turn text to fake agy for real Codex input", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const relayEvents: Array<RelayLogEvent> = [];
      const result = yield* runTurn({
        ...fixture,
        fakeMode: "success",
        input: [
          developerMessage(),
          codexPreludeMessage(),
          currentUserMessage("Read README.md line 5."),
        ],
        relayEvents,
      });

      assert.deepStrictEqual(result, { _tag: "Success", text: fakeAgyFixture.finalAnswer });
      const invocation = yield* readFakeInvocation({
        invocationLogPath: fixture.invocationLogPath,
      });
      assert.deepStrictEqual(invocation.args.slice(0, 2), ["--prompt", "Read README.md line 5."]);
      assert.strictEqual(invocation.prompt, "Read README.md line 5.");
      assert.strictEqual(invocation.prompt.includes("Use Codex developer instructions"), false);
      assert.strictEqual(invocation.prompt.includes("AGENTS.md instructions"), false);
      assert.strictEqual(invocation.prompt.includes("<environment_context>"), false);
      assert.deepStrictEqual(
        relayEvents.slice(0, 4).map((event) => event._tag),
        ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted"],
      );
    }),
  );

  it.effect("maps validated Antigravity options into exact agy argv", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const logOverride = path.join(fixture.fakeHomeDir, "logs", "override.log");
      const addDirs = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([
        "/tmp/one",
        "/tmp/two",
      ]);
      const query = new URLSearchParams({
        model: "gemini-3.5-pro",
        print_timeout_seconds: "900",
        sandbox: "true",
        add_dirs: addDirs,
        log_file: logOverride,
        dangerously_skip_permissions: "true",
        reasoning: "off",
        activity: "off",
      });
      const result = yield* runTurn({
        ...fixture,
        fakeMode: "trusted-skip-permissions",
        queryString: `?${query.toString()}`,
        relayEvents: [],
      });

      assert.deepStrictEqual(result, { _tag: "Success", text: fakeAgyFixture.finalAnswer });
      const invocation = yield* readFakeInvocation({
        invocationLogPath: fixture.invocationLogPath,
      });
      assert.deepStrictEqual(invocation.args, [
        "--prompt",
        "turn turn-1",
        "--model",
        "gemini-3.5-pro",
        "--print-timeout",
        "900s",
        "--sandbox",
        "--dangerously-skip-permissions",
        "--add-dir",
        "/tmp/one",
        "--add-dir",
        "/tmp/two",
        "--log-file",
        logOverride,
      ]);
    }),
  );

  it.effect("maps Codex advisory effort into exact Antigravity model argv", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const result = yield* runTurn({
        ...fixture,
        fakeMode: "success",
        advisoryEffort: "xhigh",
        relayEvents: [],
      });

      assert.deepStrictEqual(result, { _tag: "Success", text: fakeAgyFixture.finalAnswer });
      const invocation = yield* readFakeInvocation({
        invocationLogPath: fixture.invocationLogPath,
      });
      assert.deepStrictEqual(invocation.args.slice(2, 4), ["--model", "Gemini 3.5 Flash (High)"]);
    }),
  );

  it.effect("surfaces invalid Antigravity query options as invalid_prompt response failures", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const relayEvents: Array<RelayLogEvent> = [];
      const failed = yield* executeTurnRawFrames({
        turnId: "turn-antigravity-invalid-option",
        queryString: "?sandbox=yes",
      }).pipe(Effect.provide(providerLayer({ ...fixture, fakeMode: "success", relayEvents })));

      assert.strictEqual(failed.status, 200);
      assert.strictEqual(failed.contentType, "text/event-stream");
      assert.deepStrictEqual(frameEventNames(failed.frames), [
        "response.created",
        "response.failed",
      ]);
      assert.strictEqual(failedErrorCodeFromResponseFrames(failed.frames), "invalid_prompt");
      assert.strictEqual(
        failedErrorMessageFromResponseFrames(failed.frames),
        "Caara driver failed: sandbox must be true or false.",
      );
      assert.deepStrictEqual(assistantMessageDoneFrames(failed.frames), []);
      assert.strictEqual(frameEventNames(failed.frames).includes("response.completed"), false);
      assert.deepStrictEqual(turnFailedMessages(relayEvents), ["sandbox must be true or false."]);
    }),
  );

  for (const [fakeMode, expected] of [
    ["process-failure", "Antigravity CLI exited with code 23"],
    ["missing-log", "Antigravity CLI log file was not created"],
  ] as const) {
    it.effect(`fails explicitly when fake agy reports ${fakeMode}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const relayEvents: Array<RelayLogEvent> = [];
        const result = yield* runTurn({ ...fixture, fakeMode, relayEvents });

        assert.deepStrictEqual(result, { _tag: "StreamFailure", status: 200 });
        assert.ok(
          turnFailedMessages(relayEvents).some((message) => message.includes(expected)),
          String(turnFailedMessages(relayEvents)),
        );
      }),
    );
  }

  it.effect("surfaces accepted Antigravity process failures as response.failed", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const relayEvents: Array<RelayLogEvent> = [];
      const environment = {
        AGY_FAKE_INVOCATION_LOG: fixture.invocationLogPath,
        AGY_FAKE_MODE: "process-failure",
      };
      const layer = providerLayer({
        ...fixture,
        environment,
        fakeMode: "process-failure",
        relayEvents,
      });

      yield* assertAntigravityProcessFailureThenRecovery({
        stateDir: fixture.stateDir,
        environment,
        relayEvents,
      }).pipe(Effect.provide(layer));
    }),
  );

  for (const [fakeMode, expected] of [
    ["missing-transcript", "Antigravity transcript_full.jsonl was not created"],
    ["transcript-jsonl-only", "Antigravity transcript_full.jsonl was not created"],
    ["missing-final", "Antigravity transcript did not contain a completed final model response"],
  ] as const) {
    it.effect(`fails the stream explicitly when fake agy reports ${fakeMode}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const relayEvents: Array<RelayLogEvent> = [];
        const result = yield* runTurn({ ...fixture, fakeMode, relayEvents });

        assert.deepStrictEqual(result, { _tag: "StreamFailure", status: 200 });
        assert.ok(
          turnFailedMessages(relayEvents).some((message) => message.includes(expected)),
          String(turnFailedMessages(relayEvents)),
        );
      }),
    );
  }

  it.effect("returns a safe diagnostic final answer when fake agy exits after tool activity", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const relayEvents: Array<RelayLogEvent> = [];
      const result = yield* runTurn({
        ...fixture,
        fakeMode: "tool-only-missing-final",
        queryString: "?activity=off",
        relayEvents,
      });

      assert.deepStrictEqual(result, {
        _tag: "Success",
        text: antigravityMissingFinalDiagnosticText(),
      });
      assert.deepStrictEqual(turnFailedMessages(relayEvents), []);
    }),
  );

  it.effect("fails explicitly when the agy executable is unavailable", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const relayEvents: Array<RelayLogEvent> = [];
      const missingExecutablePath = path.join(fixture.fakeAgyPath, "missing");
      const failed = yield* executeTurnRawFrames({
        turnId: "turn-antigravity-missing-executable",
      }).pipe(
        Effect.provide(
          providerLayer({
            ...fixture,
            fakeAgyPath: missingExecutablePath,
            fakeMode: "success",
            relayEvents,
          }),
        ),
      );

      assert.strictEqual(failed.status, 200);
      assert.strictEqual(failed.contentType, "text/event-stream");
      assert.deepStrictEqual(frameEventNames(failed.frames), [
        "response.created",
        "response.failed",
      ]);
      assert.strictEqual(failedErrorCodeFromResponseFrames(failed.frames), "invalid_prompt");
      assert.strictEqual(
        failedErrorMessageFromResponseFrames(failed.frames),
        `Caara driver failed: Antigravity CLI failed to start: command ${missingExecutablePath} is not available.`,
      );
      assert.deepStrictEqual(assistantMessageDoneFrames(failed.frames), []);
      assert.strictEqual(frameEventNames(failed.frames).includes("response.completed"), false);
      assert.deepStrictEqual(turnFailedMessages(relayEvents), [
        `Antigravity CLI failed to start: command ${missingExecutablePath} is not available.`,
      ]);
    }),
  );
});
