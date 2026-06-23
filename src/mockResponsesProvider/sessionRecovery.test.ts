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
import { lostSessionRecoveryAssistantText } from "./sessionRecoveryPolicy.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Test fixture failure for recovery setup and persisted binding inspection. */
class SessionRecoveryTestError extends Schema.TaggedErrorClass<SessionRecoveryTestError>()(
  "SessionRecoveryTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged recovery test error. */
const sessionRecoveryTestError = (cause: unknown): SessionRecoveryTestError =>
  new SessionRecoveryTestError({ message: String(cause) });

/** Project root used as the Codex workspace path in recovery tests. */
const projectRoot = process.cwd();

/** Stable Codex thread id used to prove recovery behavior across turns. */
const makeThreadId = (): string => "codex-thread-session-recovery";

/** Builds Codex turn metadata for one recovery test turn. */
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

/** Builds Codex headers for one recovery test turn. */
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

/** Builds a Codex-shaped streaming Responses request body for one recovery turn. */
const makeBody = ({
  model,
  turnId,
  includeCwd,
}: {
  readonly model: string;
  readonly turnId: string;
  readonly includeCwd: boolean;
}): Schema.Json => ({
  model,
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

/** Reads an object field after asserting the parent is an object record. */
const getField = (value: unknown, field: string): unknown => {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value[field as keyof typeof value];
};

/** Builds a fresh server layer backed by one shared recovery state directory. */
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
    Layer.provideMerge(
      Layer.succeed(InputLogger, {
        logInput: Effect.fnUntraced(function* (input: Schema.Json) {
          yield* Effect.sync(() => inputs.push(input));
        }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(RequestDiagnosticsLogger, {
        logRequest: Effect.fnUntraced(function* (entry: ResponsesRequestDiagnostics) {
          yield* Effect.sync(() => diagnostics.push(entry));
        }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(RelayLogger, {
        log: Effect.fnUntraced(function* (event: RelayLogEvent) {
          yield* Effect.sync(() => relayEvents.push(event));
        }),
      }),
    ),
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

/** Runs one successful recovery test turn through the shared state directory. */
const runTurn = ({
  stateDir,
  turnId,
  model,
  url,
  includeWorkspace,
  includeCwd,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly model: string;
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
        makeBody({ model, turnId, includeCwd }),
      ),
      headers: makeHeaders({ turnId, includeWorkspace }),
    });
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    assert.strictEqual(response.status, 200);
    return assistantTextFromResponseFrames(frames);
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Runs one recovery test turn expected to fail at the transport layer. */
const runErrorTurn = ({
  stateDir,
  turnId,
  model,
  url,
  includeWorkspace,
  includeCwd,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly model: string;
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
        makeBody({ model, turnId, includeCwd }),
      ),
      headers: makeHeaders({ turnId, includeWorkspace }),
    });
    const response = yield* HttpClient.execute(request);
    const responseBody = yield* response.json;
    return {
      status: response.status,
      body: responseBody,
    };
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Creates a fresh recovery state directory under project-local temp.local. */
const makeStateDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: sessionRecoveryTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `session-recovery-${randomUUID()}-`)),
    catch: sessionRecoveryTestError,
  });
});

/** Reads the persisted binding JSON for the recovery test's Claude/thread key. */
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
    catch: sessionRecoveryTestError,
  }).pipe(Effect.map((content) => Schema.decodeSync(Schema.UnknownFromJsonString)(content)));

describe("session recovery Diagnostic integration", () => {
  it.effect("recovers an unresumable Diagnostic session with a fresh durable binding", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const firstAssistantText = yield* runTurn({
        stateDir,
        turnId: "turn-recovery-seed",
        model: "diagnostic/basic",
        url: "/v1/responses",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(firstAssistantText, diagnosticDriverFixture.basicAnswerText);

      const recoveryAssistantText = yield* runTurn({
        stateDir,
        turnId: "turn-recovery-fresh",
        model: "diagnostic/recovery",
        url: "/v1/responses?diagnostic_resume=unresumable",
        includeWorkspace: false,
        includeCwd: false,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(recoveryAssistantText, lostSessionRecoveryAssistantText);
      assert.deepStrictEqual(
        relayEvents.filter((event) => event._tag === "LostSessionRecovered"),
        [
          {
            _tag: "LostSessionRecovered",
            threadId: makeThreadId(),
            turnId: "turn-recovery-fresh",
            reason: "diagnostic-unresumable-session",
            diagnostics: {
              driver: "diagnostic",
              previousCursor: diagnosticDriverFixture.basicExternalSessionCursor,
            },
          },
        ],
      );
      assert.deepStrictEqual(yield* readPersistedBinding({ stateDir }), {
        schemaVersion: 2,
        apiResponseId: "resp_turn-recovery-fresh",
        bindingKey: {
          externalAgentKind: "diagnostic",
          driverInstanceId: "diagnostic",
          codexThreadId: makeThreadId(),
        },
        parentCodexSessionId: "parent-session-1",
        requestedTarget: {
          requestedModel: "diagnostic/recovery",
          externalModelSpecifier: "recovery",
          rawDriverOptions: { diagnostic_resume: "unresumable" },
        },
        externalSession: {
          _tag: "Durable",
          driverResumeCursor: diagnosticDriverFixture.recoveredExternalSessionCursor,
        },
        cwd: projectRoot,
        createdFromTurnId: "turn-recovery-seed",
        lastTurnId: "turn-recovery-fresh",
      });
    }),
  );

  it.effect("preserves the old binding when unresumable Diagnostic fresh start fails", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      yield* runTurn({
        stateDir,
        turnId: "turn-unrecoverable-seed",
        model: "diagnostic/basic",
        url: "/v1/responses",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });
      const originalBinding = yield* readPersistedBinding({ stateDir });

      const failure = yield* runErrorTurn({
        stateDir,
        turnId: "turn-unrecoverable-failed",
        model: "diagnostic/recovery",
        url: "/v1/responses?diagnostic_resume=unresumable&diagnostic_fresh_start=failure",
        includeWorkspace: false,
        includeCwd: false,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(failure.status, 500);
      assert.strictEqual(getField(getField(failure.body, "error"), "type"), "server_error");
      assert.match(
        String(getField(getField(failure.body, "error"), "message")),
        /fresh external session/i,
      );
      assert.deepStrictEqual(yield* readPersistedBinding({ stateDir }), originalBinding);
      assert.deepStrictEqual(
        relayEvents.filter(
          (event) => event._tag === "TurnFailed" && event.turnId === "turn-unrecoverable-failed",
        ),
        [
          {
            _tag: "TurnFailed",
            threadId: makeThreadId(),
            turnId: "turn-unrecoverable-failed",
            message: diagnosticDriverFixture.unrecoverableSessionFailureMessage,
          },
        ],
      );
    }),
  );
});
