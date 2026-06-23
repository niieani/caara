import { Effect, Layer, Match, Option, Schema, Stream } from "effect";

import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentRuntimeEvent,
  unsupportedExternalAgentKindError,
} from "./agentDriver.ts";
import { DurableExternalSession, makeDriverResumeCursor } from "./sessionDirectory.ts";
import { lostSessionRecoveryAssistantText } from "./sessionRecoveryPolicy.ts";

/** Stable simulator output and failure fixtures used by driver and transport tests. */
export const simulatorDriverFixture = {
  reasoningText: "simulator driver received claude/test",
  assistantText: "Simulator driver completed claude/test",
  resumedAssistantText: "Simulator driver resumed prior session with previous target",
  recoveryAssistantText: lostSessionRecoveryAssistantText,
  startFailureMessage: "simulator driver failed before runtime events",
  runtimeFailureBeforeOutputMessage: "simulator driver runtime failed before output",
  runtimeFailureAfterPartialMessage: "simulator driver runtime failed after partial output",
  unrecoverableSessionFailureMessage:
    "simulator driver could not resume prior session or start a fresh external session",
  externalSessionId: "simulator-session-codex-thread-session-binding",
  recoveredExternalSessionId: "simulator-session-recovered-codex-thread-session-binding",
  externalSessionCursor: '{"sessionId":"simulator-session-codex-thread-session-binding"}',
  recoveredExternalSessionCursor:
    '{"sessionId":"simulator-session-recovered-codex-thread-session-binding"}',
} as const;

/** Driver-owned simulator resume cursor schema encoded as an opaque core string. */
class SimulatorResumeCursor extends Schema.Class<SimulatorResumeCursor>("SimulatorResumeCursor")({
  sessionId: Schema.NonEmptyString,
}) {}

/** Encodes a simulator session id into the driver's opaque resume cursor string. */
const encodeSimulatorResumeCursor = (sessionId: string): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)(new SimulatorResumeCursor({ sessionId }));

/** Decodes and validates a simulator resume cursor owned by the simulator driver. */
const decodeSimulatorResumeCursor = Effect.fnUntraced(function* (driverResumeCursor: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SimulatorResumeCursor))(
    driverResumeCursor,
  ).pipe(
    Effect.mapError(
      () => new AgentDriverError({ message: "Invalid simulator driver resume cursor." }),
    ),
  );
});

/** Builds the deterministic simulator runtime event sequence for a successful turn. */
const createSimulatorEvents = (turn: AgentDriverTurn): readonly AgentRuntimeEvent[] => {
  const assistantText = Option.match(Option.fromUndefinedOr(turn.previousTarget), {
    onNone: () => simulatorDriverFixture.assistantText,
    onSome: () => simulatorDriverFixture.resumedAssistantText,
  });

  return [
    {
      _tag: "ReasoningDelta",
      text: simulatorDriverFixture.reasoningText,
    },
    {
      _tag: "AssistantMessage",
      text: assistantText,
    },
  ];
};

/** Builds the deterministic recovery reply when a durable simulator session cannot be resumed. */
const createSimulatorRecoveryEvents = (): readonly AgentRuntimeEvent[] => [
  {
    _tag: "AssistantMessage",
    text: simulatorDriverFixture.recoveryAssistantText,
  },
];

/** Returns the existing durable simulator session after validating its driver-owned cursor. */
const simulatorExternalSession = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  return yield* Option.match(Option.fromUndefinedOr(turn.externalSession), {
    onNone: () =>
      Effect.succeed(
        new DurableExternalSession({
          driverResumeCursor: makeDriverResumeCursor(
            encodeSimulatorResumeCursor(simulatorDriverFixture.externalSessionId),
          ),
        }),
      ),
    onSome: (externalSession) =>
      Match.value(externalSession).pipe(
        Match.tags({
          Durable: (durableSession) =>
            Effect.map(
              decodeSimulatorResumeCursor(durableSession.driverResumeCursor),
              () => durableSession,
            ),
          Ephemeral: () => Effect.succeed(externalSession),
        }),
        Match.exhaustive,
      ),
  });
});

/** Builds a fresh durable simulator session after recovery from an unresumable prior session. */
const recoveredSimulatorExternalSession = () =>
  new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(
      encodeSimulatorResumeCursor(simulatorDriverFixture.recoveredExternalSessionId),
    ),
  });

/** Returns a start failure marker when the simulator options request one. */
const simulatorStartFailureOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_failure).pipe(
    Option.filter((failureMode) => failureMode === "start"),
  );

/** Returns a runtime failure marker when the simulator stream should fail after start. */
const simulatorRuntimeFailureOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_failure).pipe(
    Option.filter(
      (failureMode) =>
        failureMode === "runtime_before_output" || failureMode === "runtime_after_partial",
    ),
  );

/** Builds the driver error emitted by simulator runtime failure streams. */
const simulatorRuntimeFailureError = (failureMode: string): AgentDriverError => {
  const message = Match.value(failureMode).pipe(
    Match.when(
      "runtime_after_partial",
      () => simulatorDriverFixture.runtimeFailureAfterPartialMessage,
    ),
    Match.orElse(() => simulatorDriverFixture.runtimeFailureBeforeOutputMessage),
  );
  return new AgentDriverError({ message });
};

/** Builds a stream that emits one partial reasoning event before failing. */
const simulatorPartialRuntimeFailureStream = (
  failureMode: string,
): Stream.Stream<AgentRuntimeEvent, AgentDriverError> =>
  Stream.concat(
    Stream.fromIterable<AgentRuntimeEvent>([
      {
        _tag: "ReasoningDelta",
        text: simulatorDriverFixture.reasoningText,
      },
    ]),
    Stream.fail(simulatorRuntimeFailureError(failureMode)),
  );

/** Returns a resume-failure marker when an existing simulator session should be unrecoverable. */
const simulatorResumeFailureOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_resume).pipe(
    Option.filter((resumeMode) => resumeMode === "unresumable"),
    Option.filter(() => turn.externalSession !== undefined),
  );

/** Returns a fresh-start failure marker when recovery should be unrecoverable. */
const simulatorFreshStartFailureOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_fresh_start).pipe(
    Option.filter((failureMode) => failureMode === "failure"),
  );

/** Returns a hold-open marker when simulator options request a never-ending turn. */
const simulatorHoldOpenOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_hold).pipe(
    Option.filter((holdMode) => holdMode === "open"),
  );

/** Builds the simulator runtime event stream for held-open, failing, or normal turns. */
const simulatorRuntimeEventStream = (
  turn: AgentDriverTurn,
): Stream.Stream<AgentRuntimeEvent, AgentDriverError> =>
  Option.match(simulatorRuntimeFailureOption(turn), {
    onNone: () =>
      Option.match(simulatorHoldOpenOption(turn), {
        onNone: () => Stream.fromIterable(createSimulatorEvents(turn)),
        onSome: () => Stream.never,
      }),
    onSome: (failureMode) =>
      Match.value(failureMode).pipe(
        Match.when("runtime_after_partial", () =>
          simulatorPartialRuntimeFailureStream(failureMode),
        ),
        Match.orElse(() => Stream.fail(simulatorRuntimeFailureError(failureMode))),
      ),
  });

/** Returns the simulator cancellation mode requested by driver options. */
const simulatorCancellationMode = (turn: AgentDriverTurn): string =>
  turn.target.rawDriverOptions.simulator_cancel ?? "interrupted";

/** Builds the simulator cancellation outcome for one in-flight turn. */
const simulatorCancellationOutcome = (turn: AgentDriverTurn): AgentCancellationOutcome =>
  Match.value(simulatorCancellationMode(turn)).pipe(
    Match.when(
      "abandoned_reusable",
      () =>
        ({
          _tag: "Abandoned",
          sessionReusable: true,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.when(
      "abandoned_nonreusable",
      () =>
        ({
          _tag: "Abandoned",
          sessionReusable: false,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.when(
      "terminated",
      () =>
        ({
          _tag: "Terminated",
          sessionReusable: false,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.orElse(
      () =>
        ({
          _tag: "Interrupted",
          sessionReusable: true,
        }) satisfies AgentCancellationOutcome,
    ),
  );

/** Builds the normal simulator turn result for first-turn and successful resume paths. */
const simulatorTurnResult = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  const externalSession = yield* simulatorExternalSession(turn);
  return {
    runtimeEvents: simulatorRuntimeEventStream(turn),
    externalSession,
    cancel: Effect.gen(function* () {
      yield* Effect.void;
      return simulatorCancellationOutcome(turn);
    }),
  } satisfies AgentDriverTurnResult;
});

/** Builds the simulator recovery turn result after a failed durable resume. */
const simulatorRecoveryTurnResult = (turn: AgentDriverTurn): AgentDriverTurnResult => ({
  runtimeEvents: Stream.fromIterable(createSimulatorRecoveryEvents()),
  externalSession: recoveredSimulatorExternalSession(),
  cancel: Effect.gen(function* () {
    yield* Effect.void;
    return simulatorCancellationOutcome(turn);
  }),
});

/** Recovers an unresumable simulator session by starting a fresh durable session when possible. */
const recoverUnresumableSimulatorSession = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  return yield* Option.match(simulatorFreshStartFailureOption(turn), {
    onNone: () => Effect.succeed(simulatorRecoveryTurnResult(turn)),
    onSome: () =>
      Effect.fail(
        new AgentDriverError({
          message: simulatorDriverFixture.unrecoverableSessionFailureMessage,
        }),
      ),
  });
});

/** Starts or resumes the simulator turn, including the durable-session recovery policy. */
const startSimulatorTurn = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  return yield* Option.match(simulatorResumeFailureOption(turn), {
    onNone: () => simulatorTurnResult(turn),
    onSome: () => recoverUnresumableSimulatorSession(turn),
  });
});

/** Deterministic driver used to exercise Caara transport and relay behavior. */
export const simulatorAgentDriver: AgentDriver = {
  startOrResumeTurn: Effect.fnUntraced(function* (turn: AgentDriverTurn) {
    return yield* Option.match(simulatorStartFailureOption(turn), {
      onNone: () => startSimulatorTurn(turn),
      onSome: () =>
        Effect.fail(
          new AgentDriverError({
            message: simulatorDriverFixture.startFailureMessage,
          }),
        ),
    });
  }),
};

/** Registry layer that routes supported Claude targets to the simulator driver. */
export const simulatorAgentDriverRegistryLive = Layer.succeed(AgentDriverRegistry, {
  resolve: Effect.fnUntraced(function* (target) {
    return yield* Match.value(target.externalAgentKind).pipe(
      Match.when("claude", () => Effect.succeed(simulatorAgentDriver)),
      Match.orElse((externalAgentKind) =>
        Effect.fail(unsupportedExternalAgentKindError({ externalAgentKind })),
      ),
    );
  }),
});
