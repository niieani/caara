import { Effect, Layer, Option, Stream } from "effect";

import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentDriver,
  type AgentDriverTurn,
  type AgentRuntimeEvent,
} from "./agentDriver.ts";

/** Stable simulator output and failure fixtures used by driver and transport tests. */
export const simulatorDriverFixture = {
  reasoningText: "simulator driver received claude/test",
  assistantText: "Simulator driver completed claude/test",
  startFailureMessage: "simulator driver failed before runtime events",
} as const;

/** Builds the deterministic simulator runtime event sequence for a successful turn. */
const createSimulatorEvents = (_turn: AgentDriverTurn): readonly AgentRuntimeEvent[] => [
  {
    _tag: "ReasoningDelta",
    text: simulatorDriverFixture.reasoningText,
  },
  {
    _tag: "AssistantMessage",
    text: simulatorDriverFixture.assistantText,
  },
];

/** Returns a start failure marker when the simulator options request one. */
const simulatorStartFailureOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.target.rawDriverOptions.simulator_failure).pipe(
    Option.filter((failureMode) => failureMode === "start"),
  );

/** Deterministic driver used to exercise Caara transport and relay behavior. */
export const simulatorAgentDriver: AgentDriver = {
  startOrResumeTurn: Effect.fnUntraced(function* (turn: AgentDriverTurn) {
    return yield* Option.match(simulatorStartFailureOption(turn), {
      onNone: () => Effect.succeed(Stream.fromIterable(createSimulatorEvents(turn))),
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
