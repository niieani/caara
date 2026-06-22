import { Effect, Layer, Match, Option, Stream } from "effect";

import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentRuntimeEvent,
} from "./agentDriver.ts";
import { DurableExternalSession } from "./sessionDirectory.ts";

/** Stable simulator output and failure fixtures used by driver and transport tests. */
export const simulatorDriverFixture = {
  reasoningText: "simulator driver received claude/test",
  assistantText: "Simulator driver completed claude/test",
  resumedAssistantText: "Simulator driver resumed prior session with previous target",
  recoveryAssistantText:
    "I couldn't resume the previous external agent session, so I lost the prior context of this subagent conversation. Please send me the relevant past context and restate the question.",
  startFailureMessage: "simulator driver failed before runtime events",
  unrecoverableSessionFailureMessage:
    "simulator driver could not resume prior session or start a fresh external session",
  externalSessionId: "simulator-session-codex-thread-session-binding",
  recoveredExternalSessionId: "simulator-session-recovered-codex-thread-session-binding",
} as const;

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

/** Returns the existing durable simulator session or creates a first-turn session state. */
const simulatorExternalSession = (turn: AgentDriverTurn) =>
  Option.match(Option.fromUndefinedOr(turn.externalSession), {
    onNone: () =>
      new DurableExternalSession({
        externalSessionId: simulatorDriverFixture.externalSessionId,
      }),
    onSome: (externalSession) => externalSession,
  });

/** Builds a fresh durable simulator session after recovery from an unresumable prior session. */
const recoveredSimulatorExternalSession = () =>
  new DurableExternalSession({
    externalSessionId: simulatorDriverFixture.recoveredExternalSessionId,
  });

/** Returns a start failure marker when the simulator options request one. */
const simulatorStartFailureOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_failure).pipe(
    Option.filter((failureMode) => failureMode === "start"),
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

/** Builds the simulator runtime event stream for held-open or normal turns. */
const simulatorRuntimeEventStream = (turn: AgentDriverTurn): Stream.Stream<AgentRuntimeEvent> =>
  Option.match(simulatorHoldOpenOption(turn), {
    onNone: () => Stream.fromIterable(createSimulatorEvents(turn)),
    onSome: () => Stream.never,
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
const simulatorTurnResult = (turn: AgentDriverTurn): AgentDriverTurnResult => ({
  runtimeEvents: simulatorRuntimeEventStream(turn),
  externalSession: simulatorExternalSession(turn),
  cancel: Effect.fnUntraced(function* () {
    yield* Effect.void;
    return simulatorCancellationOutcome(turn);
  }),
});

/** Builds the simulator recovery turn result after a failed durable resume. */
const simulatorRecoveryTurnResult = (turn: AgentDriverTurn): AgentDriverTurnResult => ({
  runtimeEvents: Stream.fromIterable(createSimulatorRecoveryEvents()),
  externalSession: recoveredSimulatorExternalSession(),
  cancel: Effect.fnUntraced(function* () {
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
    onNone: () => Effect.succeed(simulatorTurnResult(turn)),
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

/** Registry layer that routes currently supported Claude targets to the simulator driver. */
export const simulatorAgentDriverRegistryLive = Layer.succeed(AgentDriverRegistry, {
  resolve: () => Effect.succeed(simulatorAgentDriver),
});
