import type {
  AgentRuntimeContentKind,
  AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";

/** Active SDK content block that owns one displayable Caara runtime item lifecycle. */
export interface ClaudeAgentSdkDisplayableStreamBlock {
  readonly _tag: "Displayable";
  readonly itemId: string;
  readonly contentKind: AgentRuntimeContentKind;
}

/** Active SDK assistant text block buffered until the SDK supplies a phase-bearing stop reason. */
export interface ClaudeAgentSdkBufferedAssistantTextStreamBlock {
  readonly _tag: "BufferedAssistantText";
  readonly contentIndex: number;
  readonly text: string;
}

/** Active SDK content block whose unknown start shape makes all child deltas non-displayable. */
export interface ClaudeAgentSdkIgnoredStreamBlock {
  readonly _tag: "Ignored";
}

/** Active SDK content block currently tracked across raw stream events. */
export type ClaudeAgentSdkActiveStreamBlock =
  | ClaudeAgentSdkDisplayableStreamBlock
  | ClaudeAgentSdkBufferedAssistantTextStreamBlock
  | ClaudeAgentSdkIgnoredStreamBlock;

/** Assistant text waiting for a later SDK message or stream stop reason to classify its phase. */
export type ClaudeAgentSdkPendingAssistantText =
  | {
      readonly _tag: "StreamText";
      readonly contentIndex: number;
      readonly text: string;
    }
  | {
      readonly _tag: "CompletedText";
      readonly text: string;
    };

/** Stateful SDK-message conversion position for stable Caara runtime item ids. */
export interface ClaudeAgentSdkRuntimeEventState {
  readonly nextMessageIndex: number;
  readonly nextReasoningIndex: number;
  readonly nextActivityIndex: number;
  readonly toolUseNames: Readonly<Record<string, string>>;
  readonly activeStreamBlocks: ReadonlyMap<number, ClaudeAgentSdkActiveStreamBlock>;
  readonly streamedContentBlockIndexes: ReadonlySet<number>;
  readonly pendingAssistantTexts: readonly ClaudeAgentSdkPendingAssistantText[];
}

/** Result tuple returned while incrementally converting SDK messages. */
export type ClaudeAgentSdkRuntimeEventResult = readonly [
  ClaudeAgentSdkRuntimeEventState,
  readonly AgentRuntimeEvent[],
];

/** Initial SDK-message conversion state for one query stream. */
export const initialClaudeAgentSdkRuntimeEventState = (): ClaudeAgentSdkRuntimeEventState => ({
  nextMessageIndex: 0,
  nextReasoningIndex: 0,
  nextActivityIndex: 0,
  toolUseNames: {},
  activeStreamBlocks: new Map(),
  streamedContentBlockIndexes: new Set(),
  pendingAssistantTexts: [],
});
