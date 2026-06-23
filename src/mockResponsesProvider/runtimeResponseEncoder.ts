import type * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { Match, Option } from "effect";

import type { AgentRuntimeEvent } from "./agentDriver.ts";
import type { ResponsesCreateRequest } from "./protocol.ts";
import {
  completedEventFromState,
  createMessageItem,
  createReasoningItem,
  failedEventFromState,
  initialRuntimeResponseState,
  runtimeItemState,
  type RuntimeItemState,
  type RuntimeOutputItem,
  type RuntimeResponseState,
  upsertRuntimeItemState,
} from "./runtimeResponseTypes.ts";
import type { SseEvent } from "./sse.ts";

/** Runtime stream value after driver errors are converted into terminal failure values. */
export type RuntimeTransportEvent =
  | {
      readonly _tag: "RuntimeEvent";
      readonly runtimeEvent: AgentRuntimeEvent;
    }
  | {
      readonly _tag: "RuntimeFailure";
    };

/** Encoder step result carrying next state and the SSE frames emitted by one event. */
type RuntimeResponseEncodingResult = readonly [RuntimeResponseState, readonly SseEvent[]];

/** Adds one SSE frame and advances the Responses stream sequence number. */
const appendSseEvent = ({
  state,
  event,
}: {
  readonly state: RuntimeResponseState;
  readonly event: SseEvent;
}): RuntimeResponseEncodingResult =>
  [
    {
      ...state,
      sequenceNumber: state.sequenceNumber + 1,
    },
    [event],
  ] as const;

/** Builds the standard output-item added result for an in-progress runtime item. */
const outputItemAddedResult = ({
  state,
  outputIndex,
  item,
}: {
  readonly state: RuntimeResponseState;
  readonly outputIndex: number;
  readonly item: RuntimeOutputItem;
}): RuntimeResponseEncodingResult =>
  appendSseEvent({
    state,
    event: {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: outputIndex,
        sequence_number: state.sequenceNumber,
        item,
      } satisfies OpenAiSchema.ResponseStreamEvent,
    },
  });

/** Builds the standard output-item completion result and appends final output. */
const outputItemDoneResult = ({
  state,
  itemState,
  outputItem,
}: {
  readonly state: RuntimeResponseState;
  readonly itemState: RuntimeItemState;
  readonly outputItem: RuntimeOutputItem;
}): RuntimeResponseEncodingResult =>
  appendSseEvent({
    state: {
      ...state,
      output: [...state.output, outputItem],
    },
    event: {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: itemState.outputIndex,
        sequence_number: state.sequenceNumber,
        item: outputItem,
      } satisfies OpenAiSchema.ResponseStreamEvent,
    },
  });

/** Converts one known item content delta into its Responses frame and updated item state. */
function contentDeltaForItem({
  state,
  runtimeEvent,
  item,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;
  readonly item: RuntimeItemState;
}): RuntimeResponseEncodingResult {
  const updatedItem = {
    ...item,
    text: `${item.text}${runtimeEvent.text}`,
  } satisfies RuntimeItemState;
  const nextState = {
    ...state,
    items: upsertRuntimeItemState({ items: state.items, item: updatedItem }),
  };

  return Match.value(runtimeEvent.contentKind).pipe(
    Match.when("assistant_text", () =>
      appendSseEvent({
        state: nextState,
        event: {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            item_id: runtimeEvent.itemId,
            output_index: item.outputIndex,
            content_index: runtimeEvent.contentIndex,
            delta: runtimeEvent.text,
            sequence_number: nextState.sequenceNumber,
          } satisfies OpenAiSchema.ResponseStreamEvent,
        },
      }),
    ),
    Match.when("reasoning_summary_text", () =>
      appendSseEvent({
        state: nextState,
        event: {
          event: "response.reasoning_summary_text.delta",
          data: {
            type: "response.reasoning_summary_text.delta",
            item_id: runtimeEvent.itemId,
            output_index: item.outputIndex,
            summary_index: runtimeEvent.contentIndex,
            delta: runtimeEvent.text,
            sequence_number: nextState.sequenceNumber,
          } satisfies OpenAiSchema.ResponseStreamEvent,
        },
      }),
    ),
    Match.orElse(() => [nextState, []] as const),
  );
}

/** Converts item creation into Responses frames and next encoder state. */
const itemCreatedToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ItemCreated" }>;
}): RuntimeResponseEncodingResult => {
  const item = {
    itemId: runtimeEvent.itemId,
    itemKind: runtimeEvent.itemKind,
    outputIndex: state.nextOutputIndex,
    text: "",
  } satisfies RuntimeItemState;
  const nextState = {
    ...state,
    nextOutputIndex: state.nextOutputIndex + 1,
    items: upsertRuntimeItemState({ items: state.items, item }),
  };

  return Match.value(runtimeEvent.itemKind).pipe(
    Match.when("assistant_message", () =>
      outputItemAddedResult({
        state: nextState,
        outputIndex: item.outputIndex,
        item: createMessageItem({
          itemId: runtimeEvent.itemId,
          status: "in_progress",
          text: "",
        }),
      }),
    ),
    Match.when("reasoning", () =>
      outputItemAddedResult({
        state: nextState,
        outputIndex: item.outputIndex,
        item: createReasoningItem({ itemId: runtimeEvent.itemId }),
      }),
    ),
    Match.exhaustive,
  );
};

/** Converts content start events into Responses frames and next encoder state. */
const contentStartedToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ContentStarted" }>;
}): readonly [RuntimeResponseState, readonly SseEvent[]] =>
  Option.match(
    Option.fromUndefinedOr(runtimeItemState({ items: state.items, itemId: runtimeEvent.itemId })),
    {
      onNone: () => [state, []] as const,
      onSome: (item) =>
        Match.value(runtimeEvent.contentKind).pipe(
          Match.when(
            "reasoning_summary_text",
            () =>
              [
                {
                  ...state,
                  sequenceNumber: state.sequenceNumber + 1,
                },
                [
                  {
                    event: "response.reasoning_summary_part.added",
                    data: {
                      type: "response.reasoning_summary_part.added",
                      item_id: runtimeEvent.itemId,
                      output_index: item.outputIndex,
                      summary_index: runtimeEvent.contentIndex,
                      sequence_number: state.sequenceNumber,
                      part: { type: "summary_text", text: "" },
                    } satisfies OpenAiSchema.ResponseStreamEvent,
                  },
                ],
              ] as const,
          ),
          Match.orElse(() => [state, []] as const),
        ),
    },
  );

/** Converts content text deltas into Responses frames and next encoder state. */
const contentDeltaToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;
}): RuntimeResponseEncodingResult =>
  Option.match(
    Option.fromUndefinedOr(runtimeItemState({ items: state.items, itemId: runtimeEvent.itemId })),
    {
      onNone: () => [state, []] as const,
      onSome: (item) => contentDeltaForItem({ state, runtimeEvent, item }),
    },
  );

/** Converts content completion events into Responses frames and next encoder state. */
const contentCompletedToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ContentCompleted" }>;
}): RuntimeResponseEncodingResult =>
  Option.match(
    Option.fromUndefinedOr(runtimeItemState({ items: state.items, itemId: runtimeEvent.itemId })),
    {
      onNone: () => [state, []] as const,
      onSome: (item) =>
        Match.value(runtimeEvent.contentKind).pipe(
          Match.when(
            "reasoning_summary_text",
            () =>
              [
                {
                  ...state,
                  sequenceNumber: state.sequenceNumber + 1,
                },
                [
                  {
                    event: "response.reasoning_summary_part.done",
                    data: {
                      type: "response.reasoning_summary_part.done",
                      item_id: runtimeEvent.itemId,
                      output_index: item.outputIndex,
                      summary_index: runtimeEvent.contentIndex,
                      sequence_number: state.sequenceNumber,
                      part: { type: "summary_text", text: item.text },
                    } satisfies OpenAiSchema.ResponseStreamEvent,
                  },
                ],
              ] as const,
          ),
          Match.orElse(() => [state, []] as const),
        ),
    },
  );

/** Converts item completion into Responses frames and next encoder state. */
const itemCompletedToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ItemCompleted" }>;
}): RuntimeResponseEncodingResult =>
  Option.match(
    Option.fromUndefinedOr(runtimeItemState({ items: state.items, itemId: runtimeEvent.itemId })),
    {
      onNone: () => [state, []] as const,
      onSome: (item) =>
        Match.value(item.itemKind).pipe(
          Match.when("assistant_message", () =>
            outputItemDoneResult({
              state,
              itemState: item,
              outputItem: createMessageItem({
                itemId: item.itemId,
                status: "completed",
                text: item.text,
              }),
            }),
          ),
          Match.when("reasoning", () =>
            outputItemDoneResult({
              state,
              itemState: item,
              outputItem: createReasoningItem({ itemId: item.itemId, text: item.text }),
            }),
          ),
          Match.exhaustive,
        ),
    },
  );

/** Converts successful turn terminal events into one terminal Responses frame. */
const turnSucceededToSseEvents = ({
  request,
  state,
}: {
  readonly request: ResponsesCreateRequest;
  readonly state: RuntimeResponseState;
}): readonly [RuntimeResponseState, readonly SseEvent[]] =>
  [
    {
      ...state,
      sequenceNumber: state.sequenceNumber + 1,
      terminal: "succeeded",
    },
    [completedEventFromState({ request, state })],
  ] as const;

/** Converts failed turn terminal events into one terminal Responses frame. */
const turnFailedToSseEvents = ({
  request,
  state,
}: {
  readonly request: ResponsesCreateRequest;
  readonly state: RuntimeResponseState;
}): readonly [RuntimeResponseState, readonly SseEvent[]] =>
  [
    {
      ...state,
      sequenceNumber: state.sequenceNumber + 1,
      terminal: "failed",
    },
    [failedEventFromState({ request, state })],
  ] as const;

/** Converts one runtime lifecycle event plus encoder state into SSE frames and next state. */
const runtimeEventToSseEvents = ({
  request,
  state,
  runtimeEvent,
}: {
  readonly request: ResponsesCreateRequest;
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: AgentRuntimeEvent;
}): readonly [RuntimeResponseState, readonly SseEvent[]] =>
  Match.value(state.terminal).pipe(
    Match.when("open", () =>
      Match.valueTags(runtimeEvent, {
        ItemCreated: (event) => itemCreatedToSseEvents({ state, runtimeEvent: event }),
        ContentStarted: (event) => contentStartedToSseEvents({ state, runtimeEvent: event }),
        ContentDelta: (event) => contentDeltaToSseEvents({ state, runtimeEvent: event }),
        ContentCompleted: (event) => contentCompletedToSseEvents({ state, runtimeEvent: event }),
        ItemCompleted: (event) => itemCompletedToSseEvents({ state, runtimeEvent: event }),
        PermissionDenied: () => [state, []] as const,
        TurnSucceeded: () => turnSucceededToSseEvents({ request, state }),
        TurnFailed: () => turnFailedToSseEvents({ request, state }),
      }),
    ),
    Match.orElse(() => [state, []] as const),
  );

/** Converts one runtime transport value plus encoder state into SSE frames and next state. */
export const runtimeTransportEventToSseEvents = ({
  request,
  state,
  transportEvent,
}: {
  readonly request: ResponsesCreateRequest;
  readonly state: RuntimeResponseState;
  readonly transportEvent: RuntimeTransportEvent;
}): readonly [RuntimeResponseState, readonly SseEvent[]] =>
  Match.valueTags(transportEvent, {
    RuntimeEvent: ({ runtimeEvent }) => runtimeEventToSseEvents({ request, state, runtimeEvent }),
    RuntimeFailure: () =>
      [
        {
          ...state,
          sequenceNumber: state.sequenceNumber + 1,
          terminal: "failed",
        },
        [failedEventFromState({ request, state })],
      ] as const,
  });

/** Builds terminal SSE frames for a halted runtime transport stream. */
export const terminalEventsFromState = ({
  request,
  state,
}: {
  readonly request: ResponsesCreateRequest;
  readonly state: RuntimeResponseState;
}): readonly SseEvent[] =>
  Match.value(state.terminal).pipe(
    Match.when("succeeded", (): readonly SseEvent[] => []),
    Match.when("failed", (): readonly SseEvent[] => []),
    Match.orElse((): readonly SseEvent[] => [failedEventFromState({ request, state })]),
  );

/** Builds Responses-compatible SSE frames from normalized driver runtime events. */
export const createResponseEventsFromRuntimeEvents = ({
  request,
  runtimeEvents,
}: {
  readonly request: ResponsesCreateRequest;
  readonly runtimeEvents: readonly AgentRuntimeEvent[];
}): readonly SseEvent[] => {
  const initial = initialRuntimeResponseState({ request });
  const events: SseEvent[] = [initial.createdEvent];
  let state = initial.state;

  for (const runtimeEvent of runtimeEvents) {
    const [nextState, nextEvents] = runtimeEventToSseEvents({ request, state, runtimeEvent });
    events.push(...nextEvents);
    state = nextState;
  }
  events.push(...terminalEventsFromState({ request, state }));

  return events;
};
