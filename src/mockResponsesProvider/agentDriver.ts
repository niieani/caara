import { Context, Schema, type Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import type { AgentTarget, CodexTurnContext } from "./codexTurnContext.ts";
import type { ExternalSessionState } from "./sessionDirectory.ts";

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

/** Driver runtime stream carrying normalized runtime events or a typed driver failure. */
export type AgentRuntimeEventStream = Stream.Stream<AgentRuntimeEvent, AgentDriverError>;

/** Terminal runtime outcome for a successfully completed driver turn. */
export interface AgentRuntimeSucceeded {
  readonly _tag: "Succeeded";
  readonly externalSession: ExternalSessionState;
}

/** Terminal runtime outcome for a failed driver turn. */
export interface AgentRuntimeFailed {
  readonly _tag: "Failed";
  readonly error: AgentDriverError;
}

/** Terminal runtime outcome contract shared by driver and transport layers. */
export type AgentRuntimeTerminalOutcome = AgentRuntimeSucceeded | AgentRuntimeFailed;

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

/** Contract for cancelling one driver-owned in-flight turn. */
export type AgentDriverCancel = EffectContract<AgentCancellationOutcome>;

/** Driver start result containing runtime events and durable external session state. */
export interface AgentDriverTurnResult {
  readonly runtimeEvents: AgentRuntimeEventStream;
  readonly externalSession: ExternalSessionState;
  readonly cancel: AgentDriverCancel;
}

/** Driver failure surfaced to the Responses transport as a server error. */
export class AgentDriverError extends Schema.TaggedErrorClass<AgentDriverError>()(
  "AgentDriverError",
  {
    message: Schema.String,
  },
) {}

/** Builds an explicit registry failure for an unavailable external agent kind. */
export const unsupportedExternalAgentKindError = ({
  externalAgentKind,
}: {
  readonly externalAgentKind: string;
}): AgentDriverError =>
  new AgentDriverError({ message: `Unsupported external agent kind: ${externalAgentKind}.` });

/** Contract for starting or resuming one driver-owned turn. */
export type AgentDriverStart = (
  turn: AgentDriverTurn,
) => EffectContract<AgentDriverTurnResult, AgentDriverError>;

/** Driver implementation selected for one external agent kind. */
export interface AgentDriver {
  readonly startOrResumeTurn: AgentDriverStart;
}

/** Contract for resolving a selected agent target into a concrete driver. */
export type AgentDriverResolve = (
  target: AgentTarget,
) => EffectContract<AgentDriver, AgentDriverError>;

/** Registry that resolves the selected target into a concrete driver implementation. */
export class AgentDriverRegistry extends Context.Service<
  AgentDriverRegistry,
  {
    readonly resolve: AgentDriverResolve;
  }
>()("@caara/AgentDriverRegistry") {}
