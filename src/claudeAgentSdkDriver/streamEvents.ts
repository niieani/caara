import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Match, Option } from "effect";

import {
  type AgentRuntimeContentKind,
  type AgentRuntimeEvent,
  createReasoningSummaryRuntimeEvents,
} from "../mockResponsesProvider/agentDriver.ts";
import { messagePhaseFromAssistantStopReason } from "./assistantPhase.ts";
import {
  appendPendingStreamAssistantText,
  bufferPendingAssistantText,
  flushPendingAssistantTexts,
} from "./assistantTextBuffer.ts";
import type {
  ClaudeAgentSdkActiveStreamBlock,
  ClaudeAgentSdkBufferedAssistantTextStreamBlock,
  ClaudeAgentSdkDisplayableStreamBlock,
  ClaudeAgentSdkIgnoredStreamBlock,
  ClaudeAgentSdkRuntimeEventResult,
  ClaudeAgentSdkRuntimeEventState,
} from "./claudeAgentSdkRuntimeEventState.ts";
import { logIgnoredClaudeSdkObservation, stringField } from "./unknownObservationTelemetry.ts";

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

/** SDK message-delta event emitted after raw content blocks with the terminal stop reason. */
type ClaudeAgentSdkMessageDeltaEvent = Extract<
  Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
  { readonly type: "message_delta" }
>;

/** Returns no runtime events for SDK stream events outside the encoded subset. */
const noRuntimeEvents = (
  state: ClaudeAgentSdkRuntimeEventState,
): ClaudeAgentSdkRuntimeEventResult => [state, []] as const;

/** Metadata attached to safe telemetry for one ignored SDK stream observation. */
interface IgnoredStreamObservationContext {
  readonly sessionId: string;
  readonly index?: number;
}

/** Logs one ignored SDK stream observation and returns no runtime events. */
const ignoredStreamObservationEvents = ({
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

/** Logs and tracks one unknown stream block start. */
const ignoredStreamBlockStartedEvents = ({
  state,
  event,
  contentBlock,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockStartEvent;
  readonly contentBlock: unknown;
  readonly context: IgnoredStreamObservationContext;
}) =>
  logIgnoredClaudeSdkObservation({
    shape: `stream_event/content_block_start/${stringField(contentBlock, "type") ?? "unknown"}`,
    payload: contentBlock,
    sessionId: context.sessionId,
    index: context.index,
  }).pipe(Effect.map(() => noRuntimeEvents(withIgnoredStreamBlock({ state, index: event.index }))));

/** Returns whether one SDK stream event carries a content block index. */
const hasStreamEventIndex = (
  event: Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
): event is Extract<SDKMessage, { readonly type: "stream_event" }>["event"] & {
  readonly index: number;
} => "index" in event;

/** Extracts a content block index from SDK stream events that carry one. */
const streamEventIndex = (
  event: Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
): number | undefined =>
  Match.value(event).pipe(
    Match.when(hasStreamEventIndex, (indexedEvent) => indexedEvent.index),
    Match.orElse(() => undefined),
  );

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

/** Tracks one SDK text content block until message_delta supplies phase. */
const textContentBlockStartedEvents = ({
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

/** Appends one SDK text delta to the active assistant text buffer. */
const appendBufferedAssistantText = ({
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

/** Converts one SDK content-block delta into a buffered assistant text state update. */
const runtimeEventsFromBufferedAssistantTextDelta = ({
  state,
  bufferedBlock,
  event,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly bufferedBlock: ClaudeAgentSdkBufferedAssistantTextStreamBlock;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
  readonly context: IgnoredStreamObservationContext;
}) =>
  Match.value(event.delta).pipe(
    Match.when({ type: "text_delta" }, (delta) =>
      Effect.succeed(
        appendBufferedAssistantText({ state, activeBlock: bufferedBlock, text: delta.text }),
      ),
    ),
    Match.orElse((delta) =>
      ignoredStreamObservationEvents({
        state,
        shape: `stream_event/content_block_delta/${stringField(delta, "type") ?? "unknown"}`,
        payload: delta,
        context,
      }),
    ),
  );

/** Converts one SDK content-block delta into runtime events for a displayable stream block. */
const runtimeEventsFromDisplayableContentBlockDelta = ({
  state,
  displayableBlock,
  event,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly displayableBlock: ClaudeAgentSdkDisplayableStreamBlock;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
  readonly context: IgnoredStreamObservationContext;
}) =>
  Match.value({ contentKind: displayableBlock.contentKind, delta: event.delta }).pipe(
    Match.when({ contentKind: "assistant_text", delta: { type: "text_delta" } }, ({ delta }) =>
      Effect.succeed(
        contentDeltaEventResult({
          state,
          itemId: displayableBlock.itemId,
          contentKind: "assistant_text",
          text: delta.text,
        }),
      ),
    ),
    Match.when(
      { contentKind: "reasoning_summary_text", delta: { type: "thinking_delta" } },
      ({ delta }) =>
        Effect.succeed(
          contentDeltaEventResult({
            state,
            itemId: displayableBlock.itemId,
            contentKind: "reasoning_summary_text",
            text: delta.thinking,
          }),
        ),
    ),
    Match.orElse(({ delta }) =>
      ignoredStreamObservationEvents({
        state,
        shape: `stream_event/content_block_delta/${stringField(delta, "type") ?? "unknown"}`,
        payload: delta,
        context,
      }),
    ),
  );

/** Buffers assistant text from SDK streams that omit block starts until phase is known. */
const orphanTextDeltaEvents = ({
  state,
  contentIndex,
  text,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly contentIndex: number;
  readonly text: string;
}): ClaudeAgentSdkRuntimeEventResult => [
  appendPendingStreamAssistantText({
    state,
    contentIndex,
    text,
  }),
  [],
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
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly activeBlock: ClaudeAgentSdkActiveStreamBlock;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
  readonly context: IgnoredStreamObservationContext;
}) =>
  Match.value(activeBlock).pipe(
    Match.when({ _tag: "BufferedAssistantText" }, (bufferedBlock) =>
      runtimeEventsFromBufferedAssistantTextDelta({ state, bufferedBlock, event, context }),
    ),
    Match.when({ _tag: "Displayable" }, (displayableBlock) =>
      runtimeEventsFromDisplayableContentBlockDelta({
        state,
        displayableBlock,
        event,
        context,
      }),
    ),
    Match.when({ _tag: "Ignored" }, () =>
      ignoredStreamObservationEvents({
        state,
        shape: `stream_event/content_block_delta/ignored_block/${
          stringField(event.delta, "type") ?? "unknown"
        }`,
        payload: event.delta,
        context,
      }),
    ),
    Match.exhaustive,
  );

/** Converts a delta without a known content-block lifecycle. */
const runtimeEventsFromOrphanContentBlockDelta = ({
  state,
  event,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
  readonly context: IgnoredStreamObservationContext;
}) =>
  Match.value(event.delta).pipe(
    Match.when({ type: "text_delta" }, (delta) =>
      Effect.succeed(orphanTextDeltaEvents({ state, contentIndex: event.index, text: delta.text })),
    ),
    Match.when({ type: "thinking_delta" }, (delta) =>
      Effect.succeed(orphanThinkingDeltaEvents({ state, thinking: delta.thinking })),
    ),
    Match.orElse((delta) =>
      ignoredStreamObservationEvents({
        state,
        shape: `stream_event/content_block_delta/${stringField(delta, "type") ?? "unknown"}`,
        payload: delta,
        context,
      }),
    ),
  );

/** Converts one SDK content-block delta into runtime events. */
const runtimeEventsFromContentBlockDelta = ({
  state,
  event,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
  readonly context: IgnoredStreamObservationContext;
}) =>
  Option.match(Option.fromUndefinedOr(state.activeStreamBlocks.get(event.index)), {
    onNone: () => runtimeEventsFromOrphanContentBlockDelta({ state, event, context }),
    onSome: (activeBlock) =>
      runtimeEventsFromActiveContentBlockDelta({ state, activeBlock, event, context }),
  });

/** Converts one SDK content-block start into a runtime item start when it is displayable. */
const runtimeEventsFromContentBlockStart = ({
  state,
  event,
  context,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockStartEvent;
  readonly context: IgnoredStreamObservationContext;
}) =>
  Match.value(event.content_block).pipe(
    Match.when({ type: "text" }, (contentBlock) =>
      Effect.succeed(
        textContentBlockStartedEvents({
          state,
          index: event.index,
          initialText: contentBlock.text,
        }),
      ),
    ),
    Match.when({ type: "thinking" }, (contentBlock) =>
      Effect.succeed(
        thinkingContentBlockStartedEvents({
          state,
          index: event.index,
          initialThinking: contentBlock.thinking,
        }),
      ),
    ),
    Match.orElse((contentBlock) =>
      ignoredStreamBlockStartedEvents({
        state,
        event,
        contentBlock,
        context,
      }),
    ),
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
    onSome: (activeBlock) =>
      Match.value(activeBlock).pipe(
        Match.when(
          { _tag: "BufferedAssistantText" },
          (bufferedBlock) =>
            [
              bufferPendingAssistantText({
                state: {
                  ...state,
                  activeStreamBlocks: withoutActiveStreamBlock({ state, index: event.index }),
                },
                pendingText: {
                  _tag: "StreamText",
                  contentIndex: bufferedBlock.contentIndex,
                  text: bufferedBlock.text,
                },
              }),
              [],
            ] as const,
        ),
        Match.when(
          { _tag: "Displayable" },
          (displayableBlock) =>
            [
              {
                ...state,
                activeStreamBlocks: withoutActiveStreamBlock({ state, index: event.index }),
              },
              [
                {
                  _tag: "ContentCompleted",
                  itemId: displayableBlock.itemId,
                  contentIndex: 0,
                  contentKind: displayableBlock.contentKind,
                },
                {
                  _tag: "ItemCompleted",
                  itemId: displayableBlock.itemId,
                },
              ],
            ] as const,
        ),
        Match.when(
          { _tag: "Ignored" },
          () =>
            [
              {
                ...state,
                activeStreamBlocks: withoutActiveStreamBlock({ state, index: event.index }),
              },
              [],
            ] as const,
        ),
        Match.exhaustive,
      ),
  });

/** Converts one SDK message-delta stop reason into buffered assistant text events. */
const runtimeEventsFromMessageDelta = ({
  state,
  event,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkMessageDeltaEvent;
}): ClaudeAgentSdkRuntimeEventResult =>
  Option.match(Option.fromUndefinedOr(event.delta.stop_reason ?? undefined), {
    onNone: () => noRuntimeEvents(state),
    onSome: (stopReason): ClaudeAgentSdkRuntimeEventResult =>
      flushPendingAssistantTexts({
        state,
        messagePhase: messagePhaseFromAssistantStopReason(stopReason),
      }),
  });

/** Converts one SDK stream event message into driver-neutral runtime events. */
export const runtimeEventsFromStreamEvent = ({
  state,
  message,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<SDKMessage, { readonly type: "stream_event" }>;
}) => {
  const context = {
    sessionId: message.session_id,
    index: streamEventIndex(message.event),
  } satisfies IgnoredStreamObservationContext;
  return Match.value(message.event).pipe(
    Match.when({ type: "message_start" }, () =>
      Effect.succeed(noRuntimeEvents(resetClaudeAgentSdkStreamTracking(state))),
    ),
    Match.when({ type: "content_block_start" }, (event) =>
      runtimeEventsFromContentBlockStart({ state, event, context }),
    ),
    Match.when({ type: "content_block_delta" }, (event) =>
      runtimeEventsFromContentBlockDelta({ state, event, context }),
    ),
    Match.when({ type: "content_block_stop" }, (event) =>
      Effect.succeed(runtimeEventsFromContentBlockStop({ state, event })),
    ),
    Match.when({ type: "message_delta" }, (event) =>
      Effect.succeed(runtimeEventsFromMessageDelta({ state, event })),
    ),
    Match.orElse((event) =>
      ignoredStreamObservationEvents({
        state,
        shape: `stream_event/${stringField(event, "type") ?? "unknown"}`,
        payload: event,
        context,
      }),
    ),
  );
};
