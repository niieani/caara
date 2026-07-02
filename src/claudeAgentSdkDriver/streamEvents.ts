import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Match, Option } from "effect";

import { createReasoningSummaryRuntimeEvents } from "../mockResponsesProvider/agentDriver.ts";
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
  ClaudeAgentSdkRuntimeEventResult,
  ClaudeAgentSdkRuntimeEventState,
} from "./claudeAgentSdkRuntimeEventState.ts";
import {
  type DisplayableContentBlockDeltaCandidate,
  isAssistantTextDisplayableDelta,
  isReasoningDisplayableDelta,
  isSdkTextContentBlock,
  isSdkTextDelta,
  isSdkThinkingContentBlock,
  isSdkThinkingDelta,
} from "./sdkStreamPayloads.ts";
import {
  appendBufferedAssistantText,
  contentDeltaEventResult,
  ignoredStreamBlockStartedEvents,
  ignoredStreamObservationEvents,
  type IgnoredStreamObservationContext,
  noRuntimeEvents,
  resetClaudeAgentSdkStreamTracking,
  streamEventIndex,
  textContentBlockStartedEvents,
  thinkingContentBlockStartedEvents,
  withoutActiveStreamBlock,
} from "./streamEventState.ts";
import { stringField } from "./unknownObservationTelemetry.ts";

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
    Match.when(isSdkTextDelta, (delta) =>
      Effect.succeed(
        appendBufferedAssistantText({
          state,
          activeBlock: bufferedBlock,
          text: delta.text,
        }),
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
  Match.value({
    contentKind: displayableBlock.contentKind,
    delta: event.delta,
  } satisfies DisplayableContentBlockDeltaCandidate).pipe(
    Match.when(isAssistantTextDisplayableDelta, ({ delta }) =>
      Effect.succeed(
        contentDeltaEventResult({
          state,
          itemId: displayableBlock.itemId,
          contentKind: "assistant_text",
          text: delta.text,
        }),
      ),
    ),
    Match.when(isReasoningDisplayableDelta, ({ delta }) =>
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
    Match.when(isSdkTextDelta, (delta) =>
      Effect.succeed(
        orphanTextDeltaEvents({
          state,
          contentIndex: event.index,
          text: delta.text,
        }),
      ),
    ),
    Match.when(isSdkThinkingDelta, (delta) =>
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
    Match.when(isSdkTextContentBlock, (contentBlock) =>
      Effect.succeed(
        textContentBlockStartedEvents({
          state,
          index: event.index,
          initialText: contentBlock.text,
        }),
      ),
    ),
    Match.when(isSdkThinkingContentBlock, (contentBlock) =>
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
        index: event.index,
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
