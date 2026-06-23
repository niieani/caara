import type {
  AgentRuntimeContentKind,
  AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";

/** Active SDK content block that owns one Caara runtime item lifecycle. */
export interface ClaudeAgentSdkDisplayableStreamBlock {
  readonly _tag: "Displayable";
  readonly itemId: string;
  readonly contentKind: AgentRuntimeContentKind;
}

/** Active SDK assistant text block ignored until the completed assistant message supplies phase. */
export interface ClaudeAgentSdkIgnoredAssistantTextStreamBlock {
  readonly _tag: "IgnoredAssistantText";
}

/** Active SDK content block currently tracked across raw stream events. */
export type ClaudeAgentSdkActiveStreamBlock =
  | ClaudeAgentSdkDisplayableStreamBlock
  | ClaudeAgentSdkIgnoredAssistantTextStreamBlock;

/** Stateful SDK-message conversion position for stable Caara runtime item ids. */
export interface ClaudeAgentSdkRuntimeEventState {
  readonly nextMessageIndex: number;
  readonly nextReasoningIndex: number;
  readonly nextActivityIndex: number;
  readonly toolUseNames: Readonly<Record<string, string>>;
  readonly activeStreamBlocks: ReadonlyMap<number, ClaudeAgentSdkActiveStreamBlock>;
  readonly streamedContentBlockIndexes: ReadonlySet<number>;
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
});
