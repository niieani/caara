import { Context, Effect, Option, Schema, Stream } from "effect";

import type { AgentTarget, CodexTurnContext } from "./codexTurnContext.ts";

/** Normalized prompt data sent from Caara transport into an external agent driver. */
export interface AgentTurnInput {
  readonly input: Schema.Json;
}

/** Common input shape for one driver-facing turn relay. */
export interface AgentDriverTurn {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
  readonly prompt: AgentTurnInput;
}

/** Driver runtime event carrying incremental reasoning text. */
export interface AgentReasoningDelta {
  readonly _tag: "ReasoningDelta";
  readonly text: string;
}

/** Driver runtime event carrying a completed assistant message. */
export interface AgentAssistantMessage {
  readonly _tag: "AssistantMessage";
  readonly text: string;
}

/** Normalized runtime event emitted by an external agent driver. */
export type AgentRuntimeEvent = AgentReasoningDelta | AgentAssistantMessage;

/** Driver failure surfaced to the Responses transport as a server error. */
export class AgentDriverError extends Schema.TaggedErrorClass<AgentDriverError>()(
  "AgentDriverError",
  {
    message: Schema.String,
  },
) {}

/** Type-shape function for driver turn starts, used to avoid hand-written Effect channel tuples. */
export const agentDriverStartShape = Effect.fnUntraced(function* (_turn: AgentDriverTurn) {
  const shapeFailure = Option.none<AgentDriverError>();
  yield* Option.match(shapeFailure, {
    onNone: () => Effect.void,
    onSome: (error) => error,
  });
  return Stream.fromIterable<AgentRuntimeEvent>([]);
});

/** Driver implementation selected for one external agent kind. */
export interface AgentDriver {
  readonly startOrResumeTurn: typeof agentDriverStartShape;
}

/** Type-shape function for driver registry resolution. */
export const agentDriverResolveShape = Effect.fnUntraced(function* (_target: AgentTarget) {
  const shapeFailure = Option.none<AgentDriverError>();
  yield* Option.match(shapeFailure, {
    onNone: () => Effect.void,
    onSome: (error) => error,
  });
  return {
    startOrResumeTurn: agentDriverStartShape,
  } satisfies AgentDriver;
});

/** Registry that resolves the selected target into a concrete driver implementation. */
export class AgentDriverRegistry extends Context.Service<
  AgentDriverRegistry,
  {
    readonly resolve: typeof agentDriverResolveShape;
  }
>()("@caara/AgentDriverRegistry") {}
