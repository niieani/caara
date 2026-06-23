import type * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { Effect, Match, Option, Stream } from "effect";

import type { AgentRuntimeEvent } from "./agentDriver.ts";
import { mockResponsesFixture, type ResponsesCreateRequest } from "./protocol.ts";
import type { SseEvent } from "./sse.ts";

/** Minimal reasoning output item emitted into the Responses stream. */
interface RuntimeReasoningItem {
  readonly id: string;
  readonly type: "reasoning";
  readonly summary: readonly [];
}

/** Minimal assistant message output item emitted into the Responses stream. */
interface RuntimeMessageItem {
  readonly id: string;
  readonly type: "message";
  readonly status: "completed";
  readonly role: "assistant";
  readonly content: readonly [
    {
      readonly type: "output_text";
      readonly text: string;
      readonly annotations: readonly [];
    },
  ];
}

/** Concrete output item union emitted by the runtime event encoder. */
type RuntimeOutputItem = RuntimeReasoningItem | RuntimeMessageItem;

/** Terminal state tracked while converting runtime events into Responses frames. */
type RuntimeResponseTerminalState = "open" | "succeeded" | "failed";

/** Runtime item state accumulated until the item is completed or terminal output is emitted. */
interface RuntimeItemState {
  readonly itemId: string;
  readonly itemKind: "assistant_message" | "reasoning";
  readonly outputIndex: number;
  readonly text: string;
}

/** Stateful encoder position for streaming runtime event conversion. */
interface RuntimeResponseState {
  readonly sequenceNumber: number;
  readonly nextOutputIndex: number;
  readonly output: readonly RuntimeOutputItem[];
  readonly items: readonly RuntimeItemState[];
  readonly terminal: RuntimeResponseTerminalState;
}

/** Runtime stream value after driver errors are converted into terminal failure values. */
type RuntimeTransportEvent =
  | {
      readonly _tag: "RuntimeEvent";
      readonly runtimeEvent: AgentRuntimeEvent;
    }
  | {
      readonly _tag: "RuntimeFailure";
    };

/** Builds a minimal Responses object for the current stream state. */
const createRuntimeResponse = ({
  request,
  output,
}: {
  readonly request: ResponsesCreateRequest;
  readonly output: readonly RuntimeOutputItem[];
}) => ({
  id: "resp_simulator_driver",
  object: "response" as const,
  model: request.model,
  created_at: mockResponsesFixture.createdAtEpochSeconds,
  output,
});

/** Builds the initial Responses created event and streaming encoder state. */
const initialRuntimeResponseState = ({
  request,
}: {
  readonly request: ResponsesCreateRequest;
}): {
  readonly state: RuntimeResponseState;
  readonly createdEvent: SseEvent;
} => ({
  state: {
    sequenceNumber: 1,
    nextOutputIndex: 0,
    output: [],
    items: [],
    terminal: "open",
  },
  createdEvent: {
    event: "response.created",
    data: {
      type: "response.created",
      response: createRuntimeResponse({ request, output: [] }),
      sequence_number: 0,
    } satisfies OpenAiSchema.ResponseStreamEvent,
  },
});

/** Builds a minimal reasoning item for Responses output. */
const createReasoningItem = ({ itemId }: { readonly itemId: string }): RuntimeReasoningItem => ({
  id: itemId,
  type: "reasoning",
  summary: [],
});

/** Builds a completed assistant message item for Responses output. */
const createMessageItem = ({
  itemId,
  text,
}: {
  readonly itemId: string;
  readonly text: string;
}): RuntimeMessageItem => ({
  id: itemId,
  type: "message",
  status: "completed",
  role: "assistant",
  content: [
    {
      type: "output_text",
      text,
      annotations: [],
    },
  ],
});

/** Looks up the current state for one runtime item id. */
const runtimeItemState = ({
  items,
  itemId,
}: {
  readonly items: readonly RuntimeItemState[];
  readonly itemId: string;
}): RuntimeItemState | undefined => items.find((item) => item.itemId === itemId);

/** Replaces or inserts one runtime item state by item id. */
const upsertRuntimeItemState = ({
  items,
  item,
}: {
  readonly items: readonly RuntimeItemState[];
  readonly item: RuntimeItemState;
}): readonly RuntimeItemState[] => [
  ...items.filter((candidate) => candidate.itemId !== item.itemId),
  item,
];

/** Builds the terminal completed event from final stream encoder state. */
const completedEventFromState = ({
  request,
  state,
}: {
  readonly request: ResponsesCreateRequest;
  readonly state: RuntimeResponseState;
}): SseEvent => ({
  event: "response.completed",
  data: {
    type: "response.completed",
    response: createRuntimeResponse({ request, output: state.output }),
    sequence_number: state.sequenceNumber,
  } satisfies OpenAiSchema.ResponseStreamEvent,
});

/** Builds the terminal failed event from final stream encoder state. */
const failedEventFromState = ({
  request,
  state,
}: {
  readonly request: ResponsesCreateRequest;
  readonly state: RuntimeResponseState;
}): SseEvent => ({
  event: "response.failed",
  data: {
    type: "response.failed",
    response: createRuntimeResponse({ request, output: state.output }),
    sequence_number: state.sequenceNumber,
  } satisfies OpenAiSchema.ResponseStreamEvent,
});

/** Converts item creation into Responses frames and next encoder state. */
const itemCreatedToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ItemCreated" }>;
}): readonly [RuntimeResponseState, readonly SseEvent[]] => {
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
    Match.when("reasoning", () => {
      const reasoningItem = createReasoningItem({ itemId: runtimeEvent.itemId });
      return [
        {
          ...nextState,
          sequenceNumber: state.sequenceNumber + 1,
          output: [...state.output, reasoningItem],
        },
        [
          {
            event: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: item.outputIndex,
              sequence_number: state.sequenceNumber,
              item: reasoningItem,
            } satisfies OpenAiSchema.ResponseStreamEvent,
          },
        ],
      ] as const;
    }),
    Match.orElse(() => [nextState, []] as const),
  );
};

/** Converts content text deltas into Responses frames and next encoder state. */
const contentDeltaToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;
}): readonly [RuntimeResponseState, readonly SseEvent[]] => {
  return Option.match(
    Option.fromUndefinedOr(runtimeItemState({ items: state.items, itemId: runtimeEvent.itemId })),
    {
      onNone: () => [state, []] as const,
      onSome: (item) => {
        const updatedItem = {
          ...item,
          text: `${item.text}${runtimeEvent.text}`,
        } satisfies RuntimeItemState;
        const nextState = {
          ...state,
          items: upsertRuntimeItemState({ items: state.items, item: updatedItem }),
        };

        return Match.value(runtimeEvent.contentKind).pipe(
          Match.when(
            "reasoning_summary_text",
            () =>
              [
                {
                  ...nextState,
                  sequenceNumber: state.sequenceNumber + 1,
                },
                [
                  {
                    event: "response.reasoning_summary_text.delta",
                    data: {
                      type: "response.reasoning_summary_text.delta",
                      item_id: runtimeEvent.itemId,
                      output_index: item.outputIndex,
                      summary_index: runtimeEvent.contentIndex,
                      delta: runtimeEvent.text,
                      sequence_number: state.sequenceNumber,
                    } satisfies OpenAiSchema.ResponseStreamEvent,
                  },
                ],
              ] as const,
          ),
          Match.orElse(() => [nextState, []] as const),
        );
      },
    },
  );
};

/** Converts item completion into Responses frames and next encoder state. */
const itemCompletedToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ItemCompleted" }>;
}): readonly [RuntimeResponseState, readonly SseEvent[]] => {
  return Option.match(
    Option.fromUndefinedOr(runtimeItemState({ items: state.items, itemId: runtimeEvent.itemId })),
    {
      onNone: () => [state, []] as const,
      onSome: (item) =>
        Match.value(item.itemKind).pipe(
          Match.when("assistant_message", () => {
            const messageItem = createMessageItem({ itemId: item.itemId, text: item.text });
            return [
              {
                ...state,
                sequenceNumber: state.sequenceNumber + 1,
                output: [...state.output, messageItem],
              },
              [
                {
                  event: "response.output_item.done",
                  data: {
                    type: "response.output_item.done",
                    output_index: item.outputIndex,
                    sequence_number: state.sequenceNumber,
                    item: messageItem,
                  } satisfies OpenAiSchema.ResponseStreamEvent,
                },
              ],
            ] as const;
          }),
          Match.orElse(() => [state, []] as const),
        ),
    },
  );
};

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
}): readonly [RuntimeResponseState, readonly SseEvent[]] => {
  return Match.value(state.terminal).pipe(
    Match.when("open", () =>
      Match.valueTags(runtimeEvent, {
        ItemCreated: (event) => itemCreatedToSseEvents({ state, runtimeEvent: event }),
        ContentStarted: () => [state, []] as const,
        ContentDelta: (event) => contentDeltaToSseEvents({ state, runtimeEvent: event }),
        ContentCompleted: () => [state, []] as const,
        ItemCompleted: (event) => itemCompletedToSseEvents({ state, runtimeEvent: event }),
        TurnSucceeded: () => turnSucceededToSseEvents({ request, state }),
        TurnFailed: () => turnFailedToSseEvents({ request, state }),
      }),
    ),
    Match.orElse(() => [state, []] as const),
  );
};

/** Converts one runtime transport value plus encoder state into SSE frames and next state. */
const runtimeTransportEventToSseEvents = ({
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
const terminalEventsFromState = ({
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

/** Default no-op side effect run when a runtime stream fails. */
const defaultRuntimeFailureHandler = Effect.fnUntraced(function* () {
  yield* Effect.void;
});

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

/** Streams Responses-compatible SSE frames from normalized driver runtime events. */
export const createResponseEventStreamFromRuntimeEvents = <E, R>({
  request,
  runtimeEvents,
  onRuntimeFailure = () => defaultRuntimeFailureHandler(),
}: {
  readonly request: ResponsesCreateRequest;
  readonly runtimeEvents: Stream.Stream<AgentRuntimeEvent, E, R>;
  readonly onRuntimeFailure?: (error: E) => ReturnType<typeof defaultRuntimeFailureHandler>;
}): Stream.Stream<SseEvent, never, R> => {
  const initial = initialRuntimeResponseState({ request });
  const transportEvents = runtimeEvents.pipe(
    Stream.map(
      (runtimeEvent): RuntimeTransportEvent => ({
        _tag: "RuntimeEvent",
        runtimeEvent,
      }),
    ),
    Stream.catch((error) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          yield* onRuntimeFailure(error);
          return {
            _tag: "RuntimeFailure",
          } satisfies RuntimeTransportEvent;
        }),
      ),
    ),
  );
  const runtimeResponseEvents = transportEvents.pipe(
    Stream.mapAccum(
      () => initial.state,
      (state, transportEvent) =>
        runtimeTransportEventToSseEvents({ request, state, transportEvent }),
      {
        onHalt: (state) => terminalEventsFromState({ request, state }),
      },
    ),
  );
  return Stream.fromIterable([initial.createdEvent]).pipe(Stream.concat(runtimeResponseEvents));
};
