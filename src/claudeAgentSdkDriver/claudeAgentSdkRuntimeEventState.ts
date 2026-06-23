import type {
  AgentRuntimeContentKind,
  AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";

/** Active SDK content block that owns one Caara runtime item lifecycle. */
export interface ClaudeAgentSdkActiveStreamBlock {
  readonly itemId: string;
  readonly contentKind: AgentRuntimeContentKind;
}

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
