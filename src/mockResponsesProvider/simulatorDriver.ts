import { Effect, Layer, Match, Option, Stream } from "effect";

import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverTurn,
  type AgentRuntimeEvent,
} from "./agentDriver.ts";
import { DurableExternalSession } from "./sessionDirectory.ts";

/** Stable simulator output and failure fixtures used by driver and transport tests. */
export const simulatorDriverFixture = {
  reasoningText: "simulator driver received claude/test",
  assistantText: "Simulator driver completed claude/test",
  resumedAssistantText: "Simulator driver resumed prior session with previous target",
  startFailureMessage: "simulator driver failed before runtime events",
  externalSessionId: "simulator-session-codex-thread-session-binding",
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

/** Returns the existing durable simulator session or creates a first-turn session state. */
const simulatorExternalSession = (turn: AgentDriverTurn) =>
  Option.match(Option.fromUndefinedOr(turn.externalSession), {
    onNone: () =>
      new DurableExternalSession({
        externalSessionId: simulatorDriverFixture.externalSessionId,
      }),
    onSome: (externalSession) => externalSession,
  });

/** Returns a start failure marker when the simulator options request one. */
const simulatorStartFailureOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_failure).pipe(
    Option.filter((failureMode) => failureMode === "start"),
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

/** Deterministic driver used to exercise Caara transport and relay behavior. */
export const simulatorAgentDriver: AgentDriver = {
  startOrResumeTurn: Effect.fnUntraced(function* (turn: AgentDriverTurn) {
    return yield* Option.match(simulatorStartFailureOption(turn), {
      onNone: () =>
        Effect.succeed({
          runtimeEvents: simulatorRuntimeEventStream(turn),
          externalSession: simulatorExternalSession(turn),
          cancel: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return simulatorCancellationOutcome(turn);
          }),
        }),
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
