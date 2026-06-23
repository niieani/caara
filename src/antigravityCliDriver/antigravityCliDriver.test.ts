import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Match, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "../mockResponsesProvider/inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "../mockResponsesProvider/relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "../mockResponsesProvider/requestDiagnosticsLogger.ts";
import { assistantTextFromResponseFrames } from "../mockResponsesProvider/responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "../mockResponsesProvider/server.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { sessionBindingFilePath } from "../mockResponsesProvider/sessionDirectoryPlatform.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { antigravityCliDriverLayer } from "./driver.ts";
import { fakeAgyFixture, fakeAgyScript } from "./fakeAgyScript.ts";
import { AntigravityCliSettings } from "./settings.ts";

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

/** Failed HTTP turn result shape returned by the test transport helper. */
const FailureTurnResult = Schema.TaggedStruct("Failure", {
  status: Schema.Finite,
  body: Schema.String,
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
const makeBody = ({ turnId }: { readonly turnId: string }): Schema.Json => ({
  model: "agy/gemini-3.5-flash",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `turn ${turnId}` }],
    },
  ],
  stream: true,
  client_metadata: {
    thread_id: "codex-thread-agy",
    turn_id: turnId,
  },
  metadata: {
    cwd: projectRoot,
  },
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
  events
    .filter(
      (event): event is Extract<RelayLogEvent, { readonly _tag: "TurnFailed" }> =>
        event._tag === "TurnFailed",
    )
    .map((event) => event.message);

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
  relayEvents,
}: {
  readonly stateDir: string;
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
  readonly fakeMode: string;
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
        allowDangerousSkipPermissions: fakeMode === "trusted-skip-permissions",
        environment: {
          AGY_FAKE_INVOCATION_LOG: invocationLogPath,
          AGY_FAKE_MODE: fakeMode,
        },
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

/** Runs one HTTP turn through a provider layer configured for one fake Antigravity mode. */
const runTurn = ({
  stateDir,
  fakeAgyPath,
  fakeHomeDir,
  invocationLogPath,
  fakeMode,
  queryString,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
  readonly fakeMode: string;
  readonly queryString?: string;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const url = `/v1/responses${queryString ?? ""}`;
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(url),
        makeBody({ turnId: "turn-1" }),
      ),
      headers: makeHeaders({ turnId: "turn-1" }),
    });
    const response = yield* HttpClient.execute(request);
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
  const content = yield* Effect.tryPromise({
    try: () =>
      fs.readFile(
        sessionBindingFilePath({
          stateDir,
          externalAgentKind: "agy",
          driverInstanceId: "agy",
          codexThreadId: "codex-thread-agy",
        }),
        "utf8",
      ),
    catch: testError,
  });
  return yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(content);
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
      assert.ok(invocation.args.includes("--print"));
      assert.deepStrictEqual(invocation.args.slice(3, 5), ["--model", "gemini-3.5-flash"]);
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
        "--print",
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

  for (const [fakeMode, expected] of [
    ["process-failure", "Antigravity CLI exited with code 23"],
    ["missing-log", "Antigravity CLI log file was not created"],
  ] as const) {
    it.effect(`fails explicitly when fake agy reports ${fakeMode}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const result = yield* runTurn({ ...fixture, fakeMode, relayEvents: [] });

        const failure = yield* Schema.decodeUnknownEffect(FailureTurnResult)(result);
        assert.strictEqual(failure.status, 500);
        assert.ok(failure.body.includes(expected), failure.body);
      }),
    );
  }

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

  it.effect("fails explicitly when the agy executable is unavailable", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const result = yield* runTurn({
        ...fixture,
        fakeAgyPath: path.join(fixture.fakeAgyPath, "missing"),
        fakeMode: "success",
        relayEvents: [],
      });

      const failure = yield* Schema.decodeUnknownEffect(FailureTurnResult)(result);
      assert.strictEqual(failure.status, 500);
      assert.ok(failure.body.includes("Antigravity CLI failed to start"), failure.body);
    }),
  );
});
