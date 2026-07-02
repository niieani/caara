import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { diagnosticAgentDriverRegistryLive, diagnosticDriverFixture } from "./diagnosticDriver.ts";
import { InputLogger } from "./inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import {
  assistantTextFromResponseFrames,
  failedErrorMessageFromResponseFrames,
} from "./responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Test fixture failure for cancellation setup and response inspection. */
class TurnCancellationTestError extends Schema.TaggedErrorClass<TurnCancellationTestError>()(
  "TurnCancellationTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged cancellation test error. */
const turnCancellationTestError = (cause: unknown): TurnCancellationTestError =>
  new TurnCancellationTestError({ message: String(cause) });

/** Project root used as the Codex workspace path in cancellation tests. */
const projectRoot = process.cwd();

/** Stable ids used by cancellation scenarios. */
const cancellationScenarioIds = {
  thread: "codex-thread-cancellation",
  seedTurn: "turn-cancel-seed-1",
  reusableCancelTurn: "turn-cancel-reusable-2",
  reusableAfterTurn: "turn-cancel-reusable-after-3",
  abandonedCancelTurn: "turn-cancel-abandoned-2",
  abandonedAfterTurn: "turn-cancel-abandoned-after-3",
  invalidCancelTurn: "turn-cancel-invalid",
} as const;

/** Expected Diagnostic cancellation option to relay outcome mapping. */
const cancellationOutcomeCases = [
  {
    cancelOption: "interrupted",
    outcomeTag: "Interrupted",
    sessionReusable: true,
    turnId: "turn-cancel-outcome-interrupted",
  },
  {
    cancelOption: "abandoned_reusable",
    outcomeTag: "Abandoned",
    sessionReusable: true,
    turnId: "turn-cancel-outcome-abandoned-reusable",
  },
  {
    cancelOption: "abandoned_nonreusable",
    outcomeTag: "Abandoned",
    sessionReusable: false,
    turnId: "turn-cancel-outcome-abandoned-nonreusable",
  },
  {
    cancelOption: "terminated",
    outcomeTag: "Terminated",
    sessionReusable: false,
    turnId: "turn-cancel-outcome-terminated",
  },
] as const;

/** Builds Codex turn metadata for one cancellation test request. */
const makeTurnMetadata = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: cancellationScenarioIds.thread,
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

/** Builds Codex headers for one cancellation test request. */
const makeHeaders = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": cancellationScenarioIds.thread,
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ turnId, includeWorkspace }),
  ),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for one cancellation test turn. */
const makeBody = ({
  turnId,
  model,
  includeCwd,
}: {
  readonly turnId: string;
  readonly model: string;
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
    thread_id: cancellationScenarioIds.thread,
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

/** Decodes Responses SSE frames from a response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Decodes raw Responses SSE frames while preserving non-minimal response fields. */
const decodeRawResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

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

/** Builds a relay logger layer that captures events and signals cancellation milestones. */
const relayLoggerLayer = ({
  events,
  heldTurnStarted,
  cancellationObserved,
  heldTurnId,
}: {
  readonly events: Array<RelayLogEvent>;
  readonly heldTurnStarted: Deferred.Deferred<void>;
  readonly cancellationObserved: Deferred.Deferred<void>;
  readonly heldTurnId: string;
}) =>
  Layer.succeed(RelayLogger, {
    log: Effect.fnUntraced(function* (event: RelayLogEvent) {
      yield* Effect.sync(() => events.push(event));
      const heldStartEvent = Option.fromUndefinedOr(
        [event]
          .filter((entry) => entry._tag === "TurnInFlightAcquired" && entry.turnId === heldTurnId)
          .at(0),
      );
      const cancellationEvent = Option.fromUndefinedOr(
        [event]
          .filter((entry) => entry._tag === "TurnCancelled" && entry.turnId === heldTurnId)
          .at(0),
      );
      yield* Option.match(heldStartEvent, {
        onNone: () => Effect.void,
        onSome: () => Deferred.succeed(heldTurnStarted, undefined),
      });
      yield* Option.match(cancellationEvent, {
        onNone: () => Effect.void,
        onSome: () => Deferred.succeed(cancellationObserved, undefined),
      });
    }),
  });

/** Builds a fresh server layer backed by one shared cancellation state directory. */
const providerLayer = ({
  stateDir,
  inputs,
  diagnostics,
  relayEvents,
  heldTurnStarted,
  cancellationObserved,
  heldTurnId,
}: {
  readonly stateDir: string;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
  readonly heldTurnStarted: Deferred.Deferred<void>;
  readonly cancellationObserved: Deferred.Deferred<void>;
  readonly heldTurnId: string;
}) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(inputLoggerLayer(inputs)),
    Layer.provideMerge(diagnosticsLoggerLayer(diagnostics)),
    Layer.provideMerge(
      relayLoggerLayer({
        events: relayEvents,
        heldTurnStarted,
        cancellationObserved,
        heldTurnId,
      }),
    ),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(diagnosticAgentDriverRegistryLive),
  );

/** Builds a POST /v1/responses request for one cancellation test turn. */
const makeRequest = Effect.fnUntraced(function* ({
  turnId,
  model = "diagnostic/basic",
  url,
  includeWorkspace,
  includeCwd,
}: {
  readonly turnId: string;
  readonly model?: string;
  readonly url: string;
  readonly includeWorkspace: boolean;
  readonly includeCwd: boolean;
}) {
  return setHeaders({
    request: yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(url),
      makeBody({ turnId, model, includeCwd }),
    ),
    headers: makeHeaders({ turnId, includeWorkspace }),
  });
});

/** Runs one completed Diagnostic turn and returns its assistant text. */
const runCompletedTurn = Effect.fnUntraced(function* ({
  stateDir,
  turnId,
  includeWorkspace,
  includeCwd,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly includeWorkspace: boolean;
  readonly includeCwd: boolean;
}) {
  const relayEvents: Array<RelayLogEvent> = [];
  const heldTurnStarted = yield* Deferred.make<void>();
  const cancellationObserved = yield* Deferred.make<void>();
  const request = yield* makeRequest({
    turnId,
    url: "/v1/responses",
    includeWorkspace,
    includeCwd,
  });
  const layer = providerLayer({
    stateDir,
    inputs: [],
    diagnostics: [],
    relayEvents,
    heldTurnStarted,
    cancellationObserved,
    heldTurnId: turnId,
  });
  const response = yield* HttpClient.execute(request).pipe(Effect.provide(layer));
  const frames = yield* decodeResponseSseFrames(response.stream);
  assert.strictEqual(response.status, 200);
  return assistantTextFromResponseFrames(frames);
});

/** Runs a held Diagnostic turn and interrupts the client response stream. */
const runCancelledTurn = Effect.fnUntraced(function* ({
  stateDir,
  turnId,
  cancelOption,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly cancelOption: string;
}) {
  const inputs: Array<Schema.Json> = [];
  const diagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];
  const heldTurnStarted = yield* Deferred.make<void>();
  const cancellationObserved = yield* Deferred.make<void>();
  const layer = providerLayer({
    stateDir,
    inputs,
    diagnostics,
    relayEvents,
    heldTurnStarted,
    cancellationObserved,
    heldTurnId: turnId,
  });
  const request = yield* makeRequest({
    turnId,
    model: "diagnostic/hangs-until-cancel",
    url: `/v1/responses?diagnostic_cancel=${cancelOption}`,
    includeWorkspace: true,
    includeCwd: true,
  });

  yield* Effect.gen(function* () {
    const heldFiber = yield* HttpClient.execute(request).pipe(
      Effect.flatMap((response) => Stream.runDrain(response.stream)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.await(heldTurnStarted);
    yield* Fiber.interrupt(heldFiber);
    yield* Deferred.await(cancellationObserved);
  }).pipe(Effect.provide(layer), Effect.scoped);

  return relayEvents;
});

/** Runs one turn with an unsupported Diagnostic cancellation option and returns failure frames. */
const runInvalidCancellationOptionTurn = Effect.fnUntraced(function* ({
  stateDir,
}: {
  readonly stateDir: string;
}) {
  const relayEvents: Array<RelayLogEvent> = [];
  const heldTurnStarted = yield* Deferred.make<void>();
  const cancellationObserved = yield* Deferred.make<void>();
  const layer = providerLayer({
    stateDir,
    inputs: [],
    diagnostics: [],
    relayEvents,
    heldTurnStarted,
    cancellationObserved,
    heldTurnId: cancellationScenarioIds.invalidCancelTurn,
  });
  const request = yield* makeRequest({
    turnId: cancellationScenarioIds.invalidCancelTurn,
    url: "/v1/responses?diagnostic_cancel=bogus",
    includeWorkspace: true,
    includeCwd: true,
  });
  const response = yield* HttpClient.execute(request).pipe(Effect.provide(layer));
  const frames = yield* decodeRawResponseSseFrames(response.stream);

  return { frames, relayEvents, status: response.status };
});

/** Creates a fresh cancellation state directory under project-local temp.local. */
const makeStateDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: turnCancellationTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `turn-cancellation-${randomUUID()}-`)),
    catch: turnCancellationTestError,
  });
});

describe("turn cancellation", () => {
  it.effect("maps every Diagnostic cancellation option to a relay cancellation outcome", () =>
    Effect.forEach(cancellationOutcomeCases, (testCase) =>
      Effect.gen(function* () {
        const stateDir = yield* makeStateDir();
        const relayEvents = yield* runCancelledTurn({
          stateDir,
          turnId: testCase.turnId,
          cancelOption: testCase.cancelOption,
        });
        assert.deepStrictEqual(
          relayEvents.filter((event) => event._tag === "TurnCancelled"),
          [
            {
              _tag: "TurnCancelled",
              externalAgentKind: "diagnostic",
              codexThreadId: cancellationScenarioIds.thread,
              turnId: testCase.turnId,
              outcomeTag: testCase.outcomeTag,
              sessionReusable: testCase.sessionReusable,
            },
          ],
        );
      }),
    ),
  );

  it.effect("rejects unsupported Diagnostic cancellation option values explicitly", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const result = yield* runInvalidCancellationOptionTurn({ stateDir });

      assert.strictEqual(result.status, 200);
      assert.strictEqual(
        failedErrorMessageFromResponseFrames(result.frames),
        "Caara driver failed: Unsupported diagnostic_cancel value: bogus.",
      );
      assert.deepStrictEqual(
        result.relayEvents.map((event) => event._tag),
        [
          "TurnAccepted",
          "TargetSelected",
          "TurnInFlightAcquired",
          "DriverStarted",
          "RuntimeEventRelayed",
          "TurnFailed",
        ],
      );
    }),
  );

  it.effect("cancels a disconnected reusable turn and resumes the session later", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const firstText = yield* runCompletedTurn({
        stateDir,
        turnId: cancellationScenarioIds.seedTurn,
        includeWorkspace: true,
        includeCwd: true,
      });
      assert.strictEqual(firstText, diagnosticDriverFixture.basicAnswerText);

      const relayEvents = yield* runCancelledTurn({
        stateDir,
        turnId: cancellationScenarioIds.reusableCancelTurn,
        cancelOption: "interrupted",
      });
      assert.deepStrictEqual(
        relayEvents.filter((event) => event._tag === "TurnCancelled"),
        [
          {
            _tag: "TurnCancelled",
            externalAgentKind: "diagnostic",
            codexThreadId: cancellationScenarioIds.thread,
            turnId: cancellationScenarioIds.reusableCancelTurn,
            outcomeTag: "Interrupted",
            sessionReusable: true,
          },
        ],
      );

      const resumedText = yield* runCompletedTurn({
        stateDir,
        turnId: cancellationScenarioIds.reusableAfterTurn,
        includeWorkspace: false,
        includeCwd: false,
      });
      assert.strictEqual(resumedText, diagnosticDriverFixture.resumedBasicAnswerText);
    }),
  );

  it.effect("abandons a non-reusable disconnected turn and starts fresh later", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const firstText = yield* runCompletedTurn({
        stateDir,
        turnId: cancellationScenarioIds.seedTurn,
        includeWorkspace: true,
        includeCwd: true,
      });
      assert.strictEqual(firstText, diagnosticDriverFixture.basicAnswerText);

      const relayEvents = yield* runCancelledTurn({
        stateDir,
        turnId: cancellationScenarioIds.abandonedCancelTurn,
        cancelOption: "abandoned_nonreusable",
      });
      assert.deepStrictEqual(
        relayEvents.filter((event) => event._tag === "TurnCancelled"),
        [
          {
            _tag: "TurnCancelled",
            externalAgentKind: "diagnostic",
            codexThreadId: cancellationScenarioIds.thread,
            turnId: cancellationScenarioIds.abandonedCancelTurn,
            outcomeTag: "Abandoned",
            sessionReusable: false,
          },
        ],
      );

      const freshText = yield* runCompletedTurn({
        stateDir,
        turnId: cancellationScenarioIds.abandonedAfterTurn,
        includeWorkspace: true,
        includeCwd: true,
      });
      assert.strictEqual(freshText, diagnosticDriverFixture.basicAnswerText);
    }),
  );
});
