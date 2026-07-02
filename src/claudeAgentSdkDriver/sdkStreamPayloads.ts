import { Schema } from "effect";

import type { AgentRuntimeContentKind } from "../mockResponsesProvider/agentDriver.ts";

/** Safe subset of SDK text deltas used for streamed assistant text. */
const sdkTextDeltaSchema = Schema.Struct({
  type: Schema.Literal("text_delta"),
  text: Schema.String,
});

/** Safe subset of SDK text deltas used for streamed assistant text. */
type SdkTextDelta = typeof sdkTextDeltaSchema.Type;

/** Safe subset of SDK thinking deltas used for streamed reasoning text. */
const sdkThinkingDeltaSchema = Schema.Struct({
  type: Schema.Literal("thinking_delta"),
  thinking: Schema.String,
});

/** Safe subset of SDK thinking deltas used for streamed reasoning text. */
type SdkThinkingDelta = typeof sdkThinkingDeltaSchema.Type;

/** Safe subset of SDK text block starts used for streamed assistant text. */
const sdkTextContentBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

/** Safe subset of SDK text block starts used for streamed assistant text. */
type SdkTextContentBlock = typeof sdkTextContentBlockSchema.Type;

/** Safe subset of SDK thinking block starts used for streamed reasoning text. */
const sdkThinkingContentBlockSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
});

/** Safe subset of SDK thinking block starts used for streamed reasoning text. */
type SdkThinkingContentBlock = typeof sdkThinkingContentBlockSchema.Type;

/** Safe subset of SDK stream events that carry a content block index. */
const sdkIndexedStreamEventSchema = Schema.Struct({
  index: Schema.Finite,
});

/** Safe subset of SDK stream events that carry a content block index. */
type SdkIndexedStreamEvent = typeof sdkIndexedStreamEventSchema.Type;

/** Candidate pair used to match displayable stream block deltas. */
export interface DisplayableContentBlockDeltaCandidate {
  readonly contentKind: AgentRuntimeContentKind;
  readonly delta: unknown;
}

/** Candidate pair narrowed to assistant text deltas. */
interface AssistantTextDisplayableContentBlockDelta {
  readonly contentKind: "assistant_text";
  readonly delta: SdkTextDelta;
}

/** Candidate pair narrowed to reasoning summary deltas. */
interface ReasoningDisplayableContentBlockDelta {
  readonly contentKind: "reasoning_summary_text";
  readonly delta: SdkThinkingDelta;
}

/** Returns true when an SDK stream delta carries assistant text. */
export const isSdkTextDelta = (value: unknown): value is SdkTextDelta =>
  Schema.is(sdkTextDeltaSchema)(value);

/** Returns true when an SDK stream delta carries reasoning text. */
export const isSdkThinkingDelta = (value: unknown): value is SdkThinkingDelta =>
  Schema.is(sdkThinkingDeltaSchema)(value);

/** Returns true when an SDK content block starts assistant text. */
export const isSdkTextContentBlock = (value: unknown): value is SdkTextContentBlock =>
  Schema.is(sdkTextContentBlockSchema)(value);

/** Returns true when an SDK content block starts reasoning text. */
export const isSdkThinkingContentBlock = (value: unknown): value is SdkThinkingContentBlock =>
  Schema.is(sdkThinkingContentBlockSchema)(value);

/** Returns true when an SDK stream event carries a content block index. */
export const isSdkIndexedStreamEvent = (value: unknown): value is SdkIndexedStreamEvent =>
  Schema.is(sdkIndexedStreamEventSchema)(value);

/** Returns true when a displayable delta belongs to assistant text. */
export const isAssistantTextDisplayableDelta = (
  value: DisplayableContentBlockDeltaCandidate,
): value is AssistantTextDisplayableContentBlockDelta =>
  value.contentKind === "assistant_text" && isSdkTextDelta(value.delta);

/** Returns true when a displayable delta belongs to reasoning summary text. */
export const isReasoningDisplayableDelta = (
  value: DisplayableContentBlockDeltaCandidate,
): value is ReasoningDisplayableContentBlockDelta =>
  value.contentKind === "reasoning_summary_text" && isSdkThinkingDelta(value.delta);
