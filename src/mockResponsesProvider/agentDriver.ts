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

/** Runtime item kind emitted by driver-neutral lifecycle events. */
export type AgentRuntimeItemKind = "assistant_message" | "reasoning";

/** Runtime content kind emitted by driver-neutral lifecycle events. */
export type AgentRuntimeContentKind = "assistant_text" | "reasoning_summary_text";

/** Runtime event emitted when a driver starts an output item. */
export interface AgentRuntimeItemCreated {
  readonly _tag: "ItemCreated";
  readonly itemId: string;
  readonly itemKind: AgentRuntimeItemKind;
}

/** Runtime event emitted when a driver starts one content part for an item. */
export interface AgentRuntimeContentStarted {
  readonly _tag: "ContentStarted";
  readonly itemId: string;
  readonly contentIndex: number;
  readonly contentKind: AgentRuntimeContentKind;
}

/** Runtime event emitted when a driver streams text for one content part. */
export interface AgentRuntimeContentDelta {
  readonly _tag: "ContentDelta";
  readonly itemId: string;
  readonly contentIndex: number;
  readonly contentKind: AgentRuntimeContentKind;
  readonly text: string;
}

/** Runtime event emitted when a driver completes one content part for an item. */
export interface AgentRuntimeContentCompleted {
  readonly _tag: "ContentCompleted";
  readonly itemId: string;
  readonly contentIndex: number;
  readonly contentKind: AgentRuntimeContentKind;
}

/** Runtime event emitted when a driver completes one output item. */
export interface AgentRuntimeItemCompleted {
  readonly _tag: "ItemCompleted";
  readonly itemId: string;
}

/** Runtime event emitted when a driver completes the turn successfully. */
export interface AgentRuntimeTurnSucceeded {
  readonly _tag: "TurnSucceeded";
}

/** Runtime event emitted when a driver reports a terminal turn failure. */
export interface AgentRuntimeTurnFailed {
  readonly _tag: "TurnFailed";
  readonly error: AgentDriverError;
}

/** Normalized runtime event emitted by an external agent driver. */
export type AgentRuntimeEvent =
  | AgentRuntimeItemCreated
  | AgentRuntimeContentStarted
  | AgentRuntimeContentDelta
  | AgentRuntimeContentCompleted
  | AgentRuntimeItemCompleted
  | AgentRuntimeTurnSucceeded
  | AgentRuntimeTurnFailed;

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

/** Builds a complete assistant text lifecycle for one runtime item. */
export const createAssistantTextRuntimeEvents = ({
  itemId,
  text,
}: {
  readonly itemId: string;
  readonly text: string;
}): readonly AgentRuntimeEvent[] => [
  {
    _tag: "ItemCreated",
    itemId,
    itemKind: "assistant_message",
  },
  {
    _tag: "ContentStarted",
    itemId,
    contentIndex: 0,
    contentKind: "assistant_text",
  },
  {
    _tag: "ContentDelta",
    itemId,
    contentIndex: 0,
    contentKind: "assistant_text",
    text,
  },
  {
    _tag: "ContentCompleted",
    itemId,
    contentIndex: 0,
    contentKind: "assistant_text",
  },
  {
    _tag: "ItemCompleted",
    itemId,
  },
];

/** Builds a complete displayable reasoning-summary lifecycle for one runtime item. */
export const createReasoningSummaryRuntimeEvents = ({
  itemId,
  text,
}: {
  readonly itemId: string;
  readonly text: string;
}): readonly AgentRuntimeEvent[] => [
  {
    _tag: "ItemCreated",
    itemId,
    itemKind: "reasoning",
  },
  {
    _tag: "ContentStarted",
    itemId,
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
  },
  {
    _tag: "ContentDelta",
    itemId,
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
    text,
  },
  {
    _tag: "ContentCompleted",
    itemId,
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
  },
  {
    _tag: "ItemCompleted",
    itemId,
  },
];

/** Builds the single successful terminal event for one runtime turn. */
export const createRuntimeTurnSucceededEvent = (): AgentRuntimeTurnSucceeded => ({
  _tag: "TurnSucceeded",
});

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
