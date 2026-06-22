import { Effect, Layer, Option, Stream } from "effect";

import {
  AgentDriverError,
  AgentDriverRegistry,
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

/** Deterministic driver used to exercise Caara transport and relay behavior. */
export const simulatorAgentDriver: AgentDriver = {
  startOrResumeTurn: Effect.fnUntraced(function* (turn: AgentDriverTurn) {
    return yield* Option.match(simulatorStartFailureOption(turn), {
      onNone: () =>
        Effect.succeed({
          runtimeEvents: simulatorRuntimeEventStream(turn),
          externalSession: simulatorExternalSession(turn),
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
