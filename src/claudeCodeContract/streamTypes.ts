import { Schema } from "effect";

/** Parsed Claude Code `system/init` event carrying session and runtime metadata. */
export interface ClaudeCodeInitEvent {
  readonly _tag: "Init";
  readonly cwd: string;
  readonly sessionId: string;
  readonly tools: readonly string[];
  readonly model: string;
  readonly permissionMode: string;
  readonly version: string;
}

/** Parsed Claude Code assistant message with text content extracted from message blocks. */
export interface ClaudeCodeAssistantMessageEvent {
  readonly _tag: "AssistantMessage";
  readonly sessionId: string;
  readonly text: string;
}

/** Parsed Claude Code partial assistant text delta from verbose stream events. */
export interface ClaudeCodeTextDeltaEvent {
  readonly _tag: "TextDelta";
  readonly sessionId: string;
  readonly text: string;
}

/** Parsed Claude Code partial reasoning delta from verbose stream events. */
export interface ClaudeCodeReasoningDeltaEvent {
  readonly _tag: "ReasoningDelta";
  readonly sessionId: string;
  readonly text: string;
}

/** Parsed Claude Code user message event, including interrupt sentinels. */
export interface ClaudeCodeUserMessageEvent {
  readonly _tag: "UserMessage";
  readonly sessionId: string;
  readonly text: string;
}

/** Parsed Claude Code terminal result event. */
export interface ClaudeCodeResultEvent {
  readonly _tag: "Result";
  readonly subtype: string;
  readonly isError: boolean;
  readonly sessionId: string;
  readonly resultText: string | undefined;
  readonly stopReason: string | undefined;
  readonly terminalReason: string | undefined;
  readonly errors: readonly string[];
}

/** Parsed Claude Code event not needed by the current contract proof. */
export interface ClaudeCodeOtherEvent {
  readonly _tag: "Other";
  readonly eventType: string;
  readonly subtype: string | undefined;
  readonly sessionId: string | undefined;
}

/** Parsed event subset Caara needs from Claude Code stream-json output. */
export type ClaudeCodeContractEvent =
  | ClaudeCodeInitEvent
  | ClaudeCodeAssistantMessageEvent
  | ClaudeCodeTextDeltaEvent
  | ClaudeCodeReasoningDeltaEvent
  | ClaudeCodeUserMessageEvent
  | ClaudeCodeResultEvent
  | ClaudeCodeOtherEvent;

/** Summary of one captured Claude Code print-mode stream. */
export interface ClaudeCodeStreamSummary {
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly tools: readonly string[] | undefined;
  readonly model: string | undefined;
  readonly permissionMode: string | undefined;
  readonly version: string | undefined;
  readonly assistantText: string;
  readonly textDeltas: readonly string[];
  readonly reasoningDeltas: readonly string[];
  readonly userMessages: readonly string[];
  readonly result: ClaudeCodeResultEvent | undefined;
}

/** Proof result for whether an interrupted Claude Code stream left a reusable session. */
export type ClaudeCodeCancellationReuseProof =
  | {
      readonly _tag: "ReusableAfterInterrupt";
      readonly sessionId: string;
    }
  | {
      readonly _tag: "NotReusable";
      readonly reason: string;
    };

/** Failure raised when a Claude Code JSONL stream line cannot be decoded into the proof subset. */
export class ClaudeCodeContractParseError extends Schema.TaggedErrorClass<ClaudeCodeContractParseError>()(
  "ClaudeCodeContractParseError",
  {
    message: Schema.String,
    line: Schema.String,
  },
) {}
