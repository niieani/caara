import { Effect, Match } from "effect";

import type {
  AgentRuntimeContentKind,
  AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import type {
  ClaudeAgentSdkActiveStreamBlock,
  ClaudeAgentSdkBufferedAssistantTextStreamBlock,
  ClaudeAgentSdkIgnoredStreamBlock,
  ClaudeAgentSdkRuntimeEventResult,
  ClaudeAgentSdkRuntimeEventState,
} from "./claudeAgentSdkRuntimeEventState.ts";
import { isSdkIndexedStreamEvent } from "./sdkStreamPayloads.ts";
import { logIgnoredClaudeSdkObservation, stringField } from "./unknownObservationTelemetry.ts";

/** Metadata attached to safe telemetry for one ignored SDK stream observation. */
export interface IgnoredStreamObservationContext {
  readonly sessionId: string;
  readonly index?: number;
}

/** Returns no runtime events for SDK stream events outside the encoded subset. */
export const noRuntimeEvents = (
  state: ClaudeAgentSdkRuntimeEventState,
): ClaudeAgentSdkRuntimeEventResult => [state, []] as const;

/** Stores an active SDK stream block by raw Anthropic content-block index. */
const withActiveStreamBlock = ({
  state,
  index,
  block,
  markStreamedContent,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
  readonly block: ClaudeAgentSdkActiveStreamBlock;
  readonly markStreamedContent: boolean;
}): Pick<ClaudeAgentSdkRuntimeEventState, "activeStreamBlocks" | "streamedContentBlockIndexes"> => {
  const activeStreamBlocks = new Map(state.activeStreamBlocks);
  activeStreamBlocks.set(index, block);
  const streamedContentBlockIndexes = Match.value(markStreamedContent).pipe(
    Match.when(true, () => new Set(state.streamedContentBlockIndexes).add(index)),
    Match.orElse(() => new Set(state.streamedContentBlockIndexes)),
  );
  return {
    activeStreamBlocks,
    streamedContentBlockIndexes,
  };
};

/** Records one unknown stream block index so child deltas cannot become orphan text. */
const withIgnoredStreamBlock = ({
  state,
  index,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
}): ClaudeAgentSdkRuntimeEventState => ({
  ...state,
  ...withActiveStreamBlock({
    state,
    index,
    block: { _tag: "Ignored" } satisfies ClaudeAgentSdkIgnoredStreamBlock,
    markStreamedContent: false,
  }),
});

/** Builds one typed content-delta runtime event. */
const contentDeltaRuntimeEvent = ({
  itemId,
  contentKind,
  text,
}: {
  readonly itemId: string;
  readonly contentKind: AgentRuntimeContentKind;
  readonly text: string;
}): AgentRuntimeEvent => ({
  _tag: "ContentDelta",
  itemId,
  contentIndex: 0,
  contentKind,
  text,
});

/** Creates an optional initial content delta when a block-start event already carries content. */
const initialContentDeltaEvent = ({
  itemId,
  contentKind,
  text,
}: {
  readonly itemId: string;
  readonly contentKind: AgentRuntimeContentKind;
  readonly text: string;
}): readonly AgentRuntimeEvent[] =>
  Match.value(text).pipe(
    Match.when(
      (value) => value.length === 0,
      () => [],
    ),
    Match.orElse((value) => [contentDeltaRuntimeEvent({ itemId, contentKind, text: value })]),
  );

/** Logs one ignored SDK stream observation and returns no runtime events. */
export const ignoredStreamObservationEvents = ({
  state,
  shape,
  payload,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly shape: string;
  readonly payload: unknown;
  readonly context: IgnoredStreamObservationContext;
}) =>
  logIgnoredClaudeSdkObservation({
    shape,
    payload,
    sessionId: context.sessionId,
    index: context.index,
  }).pipe(Effect.map(() => noRuntimeEvents(state)));

/** Logs and tracks one unknown stream block start. */
export const ignoredStreamBlockStartedEvents = ({
  state,
  index,
  contentBlock,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
  readonly contentBlock: unknown;
  readonly context: IgnoredStreamObservationContext;
}) =>
  logIgnoredClaudeSdkObservation({
    shape: `stream_event/content_block_start/${stringField(contentBlock, "type") ?? "unknown"}`,
    payload: contentBlock,
    sessionId: context.sessionId,
    index: context.index,
  }).pipe(Effect.map(() => noRuntimeEvents(withIgnoredStreamBlock({ state, index }))));

/** Extracts a content block index from SDK stream events that carry one. */
export const streamEventIndex = (event: unknown): number | undefined =>
  Match.value(event).pipe(
    Match.when(isSdkIndexedStreamEvent, (indexedEvent) => indexedEvent.index),
    Match.orElse(() => undefined),
  );

/** Removes a completed SDK stream block from active block state. */
export const withoutActiveStreamBlock = ({
  state,
  index,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
}): ReadonlyMap<number, ClaudeAgentSdkActiveStreamBlock> => {
  const activeStreamBlocks = new Map(state.activeStreamBlocks);
  activeStreamBlocks.delete(index);
  return activeStreamBlocks;
};

/** Resets raw SDK message-local stream tracking for a new assistant message stream. */
export const resetClaudeAgentSdkStreamTracking = (
  state: ClaudeAgentSdkRuntimeEventState,
): ClaudeAgentSdkRuntimeEventState => ({
  ...state,
  activeStreamBlocks: new Map(),
  streamedContentBlockIndexes: new Set(),
});

/** Tracks one SDK text content block until message_delta supplies phase. */
export const textContentBlockStartedEvents = ({
  state,
  index,
  initialText,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
  readonly initialText: string;
}): ClaudeAgentSdkRuntimeEventResult =>
  [
    {
      ...state,
      ...withActiveStreamBlock({
        state,
        index,
        block: { _tag: "BufferedAssistantText", contentIndex: index, text: initialText },
        markStreamedContent: false,
      }),
    },
    [],
  ] as const;

/** Creates a runtime reasoning item for one SDK thinking content block. */
export const thinkingContentBlockStartedEvents = ({
  state,
  index,
  initialThinking,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
  readonly initialThinking: string;
}): ClaudeAgentSdkRuntimeEventResult => {
  const itemId = `claude-sdk-reasoning-${state.nextReasoningIndex}`;
  return [
    {
      ...state,
      nextReasoningIndex: state.nextReasoningIndex + 1,
      ...withActiveStreamBlock({
        state,
        index,
        block: { _tag: "Displayable", itemId, contentKind: "reasoning_summary_text" },
        markStreamedContent: true,
      }),
    },
    [
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
      ...initialContentDeltaEvent({
        itemId,
        contentKind: "reasoning_summary_text",
        text: initialThinking,
      }),
    ],
  ] as const;
};

/** Converts one SDK content-block delta into runtime events. */
export const contentDeltaEventResult = ({
  state,
  itemId,
  contentKind,
  text,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly itemId: string;
  readonly contentKind: AgentRuntimeContentKind;
  readonly text: string;
}): ClaudeAgentSdkRuntimeEventResult => [
  state,
  [contentDeltaRuntimeEvent({ itemId, contentKind, text })],
];

/** Appends one SDK text delta to the active assistant text buffer. */
export const appendBufferedAssistantText = ({
  state,
  activeBlock,
  text,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly activeBlock: ClaudeAgentSdkBufferedAssistantTextStreamBlock;
  readonly text: string;
}): ClaudeAgentSdkRuntimeEventResult => {
  const activeStreamBlocks = new Map(state.activeStreamBlocks);
  activeStreamBlocks.set(activeBlock.contentIndex, {
    ...activeBlock,
    text: `${activeBlock.text}${text}`,
  });
  return [{ ...state, activeStreamBlocks }, []] as const;
};
