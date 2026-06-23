import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "./inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./server.ts";
import {
  CaaraSessionBinding,
  sessionBindingFilePath,
  sessionDirectoryLive,
} from "./sessionDirectory.ts";
import { simulatorAgentDriverRegistryLive, simulatorDriverFixture } from "./simulatorDriver.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Test fixture failure for runtime-failure setup and persisted binding inspection. */
class RuntimeFailureTestError extends Schema.TaggedErrorClass<RuntimeFailureTestError>()(
  "RuntimeFailureTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged runtime-failure test error. */
const runtimeFailureTestError = (cause: unknown): RuntimeFailureTestError =>
  new RuntimeFailureTestError({ message: String(cause) });

/** Project root used as the Codex workspace path in runtime-failure tests. */
const projectRoot = process.cwd();

/** Stable Codex thread id used to prove binding state after failed turns. */
const makeThreadId = (): string => "codex-thread-runtime-failure";

/** Builds Codex turn metadata for one runtime-failure test turn. */
const makeTurnMetadata = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: makeThreadId(),
  turn_id: turnId,
  window_id: "window-1",
  request_kind: "turn",
  parent_thread_id: "parent-thread-1",
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

/** Builds Codex headers for one runtime-failure test turn. */
const makeHeaders = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": makeThreadId(),
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ turnId, includeWorkspace }),
  ),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for one runtime-failure turn. */
const makeBody = ({
  turnId,
  includeCwd,
}: {
  readonly turnId: string;
  readonly includeCwd: boolean;
}): Schema.Json => ({
  model: "claude/test",
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

/** Decoded Responses SSE frame from the real response byte stream. */
interface ResponseSseFrame {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: OpenAiSchema.ResponseStreamEvent;
}

/** Decodes Responses SSE frames from a response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Extracts the ordered SSE event names from decoded response frames. */
const frameEventNames = (frames: readonly ResponseSseFrame[]): readonly string[] =>
  frames.map((frame) => frame.event);

/** Extracts the completed assistant text from decoded Responses SSE frames. */
const assistantTextFromFrames = (frames: readonly ResponseSseFrame[]): string => {
  const messageDone = frames.find((frame) => frame.event === "response.output_item.done");
  assert.ok(messageDone, "missing assistant message done event");
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      item: Schema.Struct({
        content: Schema.Array(
          Schema.Struct({
            text: Schema.String,
          }),
        ),
      }),
    }),
  )(messageDone.data);
  const firstContent = decoded.item.content.at(0);
  assert.ok(firstContent, "missing assistant content");
  return firstContent.text;
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

/** Builds a fresh server layer backed by one shared runtime-failure state directory. */
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
    Layer.provideMerge(sessionDirectoryLive({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(simulatorAgentDriverRegistryLive),
  );

/** Creates a fresh runtime-failure state directory under project-local temp.local. */
const makeStateDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: runtimeFailureTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `runtime-failure-${randomUUID()}-`)),
    catch: runtimeFailureTestError,
  });
});

/** Returns the persisted binding path for the runtime-failure test session key. */
const persistedBindingPath = ({ stateDir }: { readonly stateDir: string }): string =>
  sessionBindingFilePath({
    stateDir,
    externalAgentKind: "claude",
    codexThreadId: makeThreadId(),
  });

/** Returns whether a session binding file exists for the test session key. */
const bindingExists = Effect.fnUntraced(function* ({ stateDir }: { readonly stateDir: string }) {
  return yield* Effect.tryPromise({
    try: () => Bun.file(persistedBindingPath({ stateDir })).exists(),
    catch: runtimeFailureTestError,
  });
});

/** Reads and decodes the persisted binding for the test session key. */
const readPersistedBinding = Effect.fnUntraced(function* ({
  stateDir,
}: {
  readonly stateDir: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(persistedBindingPath({ stateDir }), "utf8"),
    catch: runtimeFailureTestError,
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CaaraSessionBinding))(
    content,
  ).pipe(Effect.mapError((cause) => runtimeFailureTestError(cause)));
});

/** Runs one HTTP turn through a provider layer that shares one state directory. */
const runTurn = Effect.fnUntraced(function* ({
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
}) {
  const request = setHeaders({
    request: yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(url),
      makeBody({ turnId, includeCwd }),
    ),
    headers: makeHeaders({ turnId, includeWorkspace }),
  });
  const response = yield* HttpClient.execute(request).pipe(
    Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })),
  );
  const frames = yield* decodeResponseSseFrames(response.stream);
  assert.strictEqual(response.status, 200);
  return frames;
});

describe("runtime stream failure handling", () => {
  it.effect("fails before output without completing the response or creating a binding", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const failedFrames = yield* runTurn({
        stateDir,
        turnId: "turn-runtime-fails-before-output",
        url: "/v1/responses?simulator_failure=runtime_before_output",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });

      assert.deepStrictEqual(frameEventNames(failedFrames), [
        "response.created",
        "response.failed",
      ]);
      assert.strictEqual(yield* bindingExists({ stateDir }), false);
      assert.deepStrictEqual(
        relayEvents.map((event) => event._tag),
        ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted", "TurnFailed"],
      );
      assert.deepStrictEqual(relayEvents.at(-1), {
        _tag: "TurnFailed",
        threadId: makeThreadId(),
        turnId: "turn-runtime-fails-before-output",
        message: simulatorDriverFixture.runtimeFailureBeforeOutputMessage,
      });

      const recoveryFrames = yield* runTurn({
        stateDir,
        turnId: "turn-runtime-after-before-output-failure",
        url: "/v1/responses",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(
        assistantTextFromFrames(recoveryFrames),
        simulatorDriverFixture.assistantText,
      );
    }),
  );

  it.effect("fails after partial output without completing or advancing an existing binding", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const seedFrames = yield* runTurn({
        stateDir,
        turnId: "turn-runtime-seed",
        url: "/v1/responses",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(assistantTextFromFrames(seedFrames), simulatorDriverFixture.assistantText);

      const failedFrames = yield* runTurn({
        stateDir,
        turnId: "turn-runtime-fails-after-partial",
        url: "/v1/responses?simulator_failure=runtime_after_partial",
        includeWorkspace: false,
        includeCwd: false,
        inputs,
        diagnostics,
        relayEvents,
      });

      assert.deepStrictEqual(frameEventNames(failedFrames), [
        "response.created",
        "response.output_item.added",
        "response.reasoning_summary_text.delta",
        "response.failed",
      ]);
      const bindingAfterFailure = yield* readPersistedBinding({ stateDir });
      assert.strictEqual(bindingAfterFailure.lastTurnId, "turn-runtime-seed");
      assert.strictEqual(bindingAfterFailure.createdFromTurnId, "turn-runtime-seed");
      assert.deepStrictEqual(
        relayEvents.filter((event) => event._tag === "TurnFailed"),
        [
          {
            _tag: "TurnFailed",
            threadId: makeThreadId(),
            turnId: "turn-runtime-fails-after-partial",
            message: simulatorDriverFixture.runtimeFailureAfterPartialMessage,
          },
        ],
      );

      const resumedFrames = yield* runTurn({
        stateDir,
        turnId: "turn-runtime-after-partial-failure",
        url: "/v1/responses",
        includeWorkspace: false,
        includeCwd: false,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(
        assistantTextFromFrames(resumedFrames),
        simulatorDriverFixture.resumedAssistantText,
      );
    }),
  );
});
