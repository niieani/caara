import { Context, Effect, Option, Schema, Stream } from "effect";

import type { AgentTarget, CodexTurnContext } from "./codexTurnContext.ts";
import { EphemeralExternalSession, type ExternalSessionState } from "./sessionDirectory.ts";

/** Normalized prompt data sent from Caara transport into an external agent driver. */
export interface AgentTurnInput {
  readonly input: Schema.Json;
}

/** Common input shape for one driver-facing turn relay. */
export interface AgentDriverTurn {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
  readonly prompt: AgentTurnInput;
  readonly cwd: string;
  readonly previousTarget: AgentTarget | undefined;
  readonly externalSession: ExternalSessionState | undefined;
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

/** Cancellation outcome for a turn interrupted before hidden session mutation. */
export interface AgentCancellationInterrupted {
  readonly _tag: "Interrupted";
  readonly sessionReusable: true;
}

/** Cancellation outcome for a turn abandoned while the driver may still be running. */
export interface AgentCancellationAbandoned {
  readonly _tag: "Abandoned";
  readonly sessionReusable: boolean;
}

/** Cancellation outcome for a turn whose external harness was terminated. */
export interface AgentCancellationTerminated {
  readonly _tag: "Terminated";
  readonly sessionReusable: false;
}

/** Driver-reported outcome after Caara asks an in-flight turn to stop. */
export type AgentCancellationOutcome =
  | AgentCancellationInterrupted
  | AgentCancellationAbandoned
  | AgentCancellationTerminated;

/** Default cancellation outcome for drivers whose test shape has no custom cancellation behavior. */
const defaultCancellationOutcome = (): AgentCancellationOutcome => ({
  _tag: "Interrupted",
  sessionReusable: true,
});

/** Type-shape function for cancelling one driver-owned in-flight turn. */
export const agentDriverCancelShape = Effect.fnUntraced(function* () {
  yield* Effect.void;
  return defaultCancellationOutcome();
});

/** Driver start result containing runtime events and durable external session state. */
export interface AgentDriverTurnResult {
  readonly runtimeEvents: Stream.Stream<AgentRuntimeEvent, AgentDriverError>;
  readonly externalSession: ExternalSessionState;
  readonly cancel: typeof agentDriverCancelShape;
}

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
  const externalSessionChoices: readonly ExternalSessionState[] = [new EphemeralExternalSession()];
  const externalSession = Option.getOrThrow(Option.fromUndefinedOr(externalSessionChoices.at(0)));
  const runtimeEvents: Stream.Stream<AgentRuntimeEvent, AgentDriverError> =
    Stream.fromIterable<AgentRuntimeEvent>([]);
  return {
    runtimeEvents,
    externalSession,
    cancel: agentDriverCancelShape,
  } satisfies AgentDriverTurnResult;
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
