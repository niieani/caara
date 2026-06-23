import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Match, Option } from "effect";

import {
  type AgentRuntimeContentKind,
  type AgentRuntimeEvent,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
} from "../mockResponsesProvider/agentDriver.ts";
import type {
  ClaudeAgentSdkActiveStreamBlock,
  ClaudeAgentSdkRuntimeEventResult,
  ClaudeAgentSdkRuntimeEventState,
} from "./claudeAgentSdkRuntimeEventState.ts";

/** SDK content-block delta event emitted inside the partial assistant stream. */
type ClaudeAgentSdkContentBlockDeltaEvent = Extract<
  Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
  { readonly type: "content_block_delta" }
>;

/** SDK content-block start event emitted inside the partial assistant stream. */
type ClaudeAgentSdkContentBlockStartEvent = Extract<
  Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
  { readonly type: "content_block_start" }
>;

/** SDK content-block stop event emitted inside the partial assistant stream. */
type ClaudeAgentSdkContentBlockStopEvent = Extract<
  Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
  { readonly type: "content_block_stop" }
>;

/** Returns no runtime events for SDK stream events outside the encoded subset. */
const noRuntimeEvents = (
  state: ClaudeAgentSdkRuntimeEventState,
): ClaudeAgentSdkRuntimeEventResult => [state, []] as const;

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

/** Stores an active SDK stream block by raw Anthropic content-block index. */
const withActiveStreamBlock = ({
  state,
  index,
  block,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
  readonly block: ClaudeAgentSdkActiveStreamBlock;
}): Pick<ClaudeAgentSdkRuntimeEventState, "activeStreamBlocks" | "streamedContentBlockIndexes"> => {
  const activeStreamBlocks = new Map(state.activeStreamBlocks);
  activeStreamBlocks.set(index, block);
  const streamedContentBlockIndexes = new Set(state.streamedContentBlockIndexes);
  streamedContentBlockIndexes.add(index);
  return {
    activeStreamBlocks,
    streamedContentBlockIndexes,
  };
};

/** Removes a completed SDK stream block from active block state. */
const withoutActiveStreamBlock = ({
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

/** Creates a runtime assistant item for one SDK text content block. */
const textContentBlockStartedEvents = ({
  state,
  index,
  initialText,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly index: number;
  readonly initialText: string;
}): ClaudeAgentSdkRuntimeEventResult => {
  const itemId = `claude-sdk-message-${state.nextMessageIndex}`;
  return [
    {
      ...state,
      nextMessageIndex: state.nextMessageIndex + 1,
      ...withActiveStreamBlock({
        state,
        index,
        block: { itemId, contentKind: "assistant_text" },
      }),
    },
    [
      {
        _tag: "ItemCreated",
        itemId,
        itemKind: "assistant_message",
        messagePhase: "final_answer",
      },
      {
        _tag: "ContentStarted",
        itemId,
        contentIndex: 0,
        contentKind: "assistant_text",
      },
      ...initialContentDeltaEvent({ itemId, contentKind: "assistant_text", text: initialText }),
    ],
  ] as const;
};

/** Creates a runtime reasoning item for one SDK thinking content block. */
const thinkingContentBlockStartedEvents = ({
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
        block: { itemId, contentKind: "reasoning_summary_text" },
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
const contentDeltaEventResult = ({
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

/** Builds a complete assistant-message fallback for SDK streams that omit block starts. */
const orphanTextDeltaEvents = ({
  state,
  text,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly text: string;
}): ClaudeAgentSdkRuntimeEventResult => [
  {
    ...state,
    nextMessageIndex: state.nextMessageIndex + 1,
  },
  createAssistantTextRuntimeEvents({
    itemId: `claude-sdk-message-${state.nextMessageIndex}`,
    text,
    messagePhase: "final_answer",
  }),
];

/** Builds a complete reasoning fallback for SDK streams that omit block starts. */
const orphanThinkingDeltaEvents = ({
  state,
  thinking,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly thinking: string;
}): ClaudeAgentSdkRuntimeEventResult => [
  {
    ...state,
    nextReasoningIndex: state.nextReasoningIndex + 1,
  },
  createReasoningSummaryRuntimeEvents({
    itemId: `claude-sdk-reasoning-${state.nextReasoningIndex}`,
    text: thinking,
  }),
];

/** Converts one SDK content-block delta into runtime events for an active stream block. */
const runtimeEventsFromActiveContentBlockDelta = ({
  state,
  activeBlock,
  event,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly activeBlock: ClaudeAgentSdkActiveStreamBlock;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
}): ClaudeAgentSdkRuntimeEventResult =>
  Match.value({ contentKind: activeBlock.contentKind, delta: event.delta }).pipe(
    Match.when({ contentKind: "assistant_text", delta: { type: "text_delta" } }, ({ delta }) =>
      contentDeltaEventResult({
        state,
        itemId: activeBlock.itemId,
        contentKind: "assistant_text",
        text: delta.text,
      }),
    ),
    Match.when(
      { contentKind: "reasoning_summary_text", delta: { type: "thinking_delta" } },
      ({ delta }) =>
        contentDeltaEventResult({
          state,
          itemId: activeBlock.itemId,
          contentKind: "reasoning_summary_text",
          text: delta.thinking,
        }),
    ),
    Match.orElse(() => noRuntimeEvents(state)),
  );

/** Converts a delta without a known content-block lifecycle using the legacy single-item fallback. */
const runtimeEventsFromOrphanContentBlockDelta = ({
  state,
  event,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
}): ClaudeAgentSdkRuntimeEventResult =>
  Match.value(event.delta).pipe(
    Match.when({ type: "text_delta" }, (delta) =>
      orphanTextDeltaEvents({ state, text: delta.text }),
    ),
    Match.when({ type: "thinking_delta" }, (delta) =>
      orphanThinkingDeltaEvents({ state, thinking: delta.thinking }),
    ),
    Match.orElse(() => noRuntimeEvents(state)),
  );

/** Converts one SDK content-block delta into runtime events. */
const runtimeEventsFromContentBlockDelta = ({
  state,
  event,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
}): ClaudeAgentSdkRuntimeEventResult =>
  Option.match(Option.fromUndefinedOr(state.activeStreamBlocks.get(event.index)), {
    onNone: () => runtimeEventsFromOrphanContentBlockDelta({ state, event }),
    onSome: (activeBlock) =>
      runtimeEventsFromActiveContentBlockDelta({ state, activeBlock, event }),
  });

/** Converts one SDK content-block start into a runtime item start when it is displayable. */
const runtimeEventsFromContentBlockStart = ({
  state,
  event,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockStartEvent;
}): ClaudeAgentSdkRuntimeEventResult =>
  Match.value(event.content_block).pipe(
    Match.when({ type: "text" }, (contentBlock) =>
      textContentBlockStartedEvents({
        state,
        index: event.index,
        initialText: contentBlock.text,
      }),
    ),
    Match.when({ type: "thinking" }, (contentBlock) =>
      thinkingContentBlockStartedEvents({
        state,
        index: event.index,
        initialThinking: contentBlock.thinking,
      }),
    ),
    Match.orElse(() => noRuntimeEvents(state)),
  );

/** Converts one SDK content-block stop into a runtime item completion. */
const runtimeEventsFromContentBlockStop = ({
  state,
  event,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockStopEvent;
}): ClaudeAgentSdkRuntimeEventResult =>
  Option.match(Option.fromUndefinedOr(state.activeStreamBlocks.get(event.index)), {
    onNone: () => noRuntimeEvents(state),
    onSome: (activeBlock) => [
      {
        ...state,
        activeStreamBlocks: withoutActiveStreamBlock({ state, index: event.index }),
      },
      [
        {
          _tag: "ContentCompleted",
          itemId: activeBlock.itemId,
          contentIndex: 0,
          contentKind: activeBlock.contentKind,
        },
        {
          _tag: "ItemCompleted",
          itemId: activeBlock.itemId,
        },
      ],
    ],
  });

/** Converts one SDK stream event message into driver-neutral runtime events. */
export const runtimeEventsFromStreamEvent = ({
  state,
  message,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<SDKMessage, { readonly type: "stream_event" }>;
}): ClaudeAgentSdkRuntimeEventResult =>
  Match.value(message.event).pipe(
    Match.when({ type: "message_start" }, () =>
      noRuntimeEvents(resetClaudeAgentSdkStreamTracking(state)),
    ),
    Match.when({ type: "content_block_start" }, (event) =>
      runtimeEventsFromContentBlockStart({ state, event }),
    ),
    Match.when({ type: "content_block_delta" }, (event) =>
      runtimeEventsFromContentBlockDelta({ state, event }),
    ),
    Match.when({ type: "content_block_stop" }, (event) =>
      runtimeEventsFromContentBlockStop({ state, event }),
    ),
    Match.orElse(() => noRuntimeEvents(state)),
  );
