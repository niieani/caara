import type * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { Effect, Match, Stream } from "effect";

import type { AgentRuntimeEvent } from "./agentDriver.ts";
import { mockResponsesFixture, type ResponsesCreateRequest } from "./protocol.ts";
import type { SseEvent } from "./sse.ts";

/** Builds the minimal Responses API event stream Codex needs for this mock. */
export const createMockResponseEvents = ({
  request,
}: {
  readonly request: ResponsesCreateRequest;
}): readonly SseEvent[] => {
  const reasoningItem = {
    id: mockResponsesFixture.reasoningItemId,
    type: "reasoning",
    summary: [],
  } as const;

  const messageItem = {
    id: mockResponsesFixture.messageItemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: mockResponsesFixture.assistantText,
        annotations: [],
      },
    ],
  } as const;

  /** Minimal response object required by Effect OpenAI stream-event schemas. */
  const createResponse = (output: readonly (typeof reasoningItem | typeof messageItem)[]) => ({
    id: mockResponsesFixture.responseId,
    object: "response" as const,
    model: request.model,
    created_at: mockResponsesFixture.createdAtEpochSeconds,
    output,
  });

  const createdEvent = {
    type: "response.created",
    response: createResponse([]),
    sequence_number: 0,
  } as const satisfies OpenAiSchema.ResponseStreamEvent;

  const reasoningAddedEvent = {
    type: "response.output_item.added",
    output_index: 0,
    sequence_number: 1,
    item: reasoningItem,
  } as const satisfies OpenAiSchema.ResponseStreamEvent;

  const reasoningDeltaEvent = {
    type: "response.reasoning_summary_text.delta",
    item_id: mockResponsesFixture.reasoningItemId,
    output_index: 0,
    summary_index: 0,
    delta: mockResponsesFixture.reasoningText,
    sequence_number: 2,
  } as const satisfies OpenAiSchema.ResponseStreamEvent;

  const messageDoneEvent = {
    type: "response.output_item.done",
    output_index: 1,
    sequence_number: 3,
    item: messageItem,
  } as const satisfies OpenAiSchema.ResponseStreamEvent;

  const completedEvent = {
    type: "response.completed",
    response: createResponse([reasoningItem, messageItem]),
    sequence_number: 4,
  } as const satisfies OpenAiSchema.ResponseStreamEvent;

  return [
    {
      event: createdEvent.type,
      data: createdEvent,
    },
    {
      event: reasoningAddedEvent.type,
      data: reasoningAddedEvent,
    },
    {
      event: reasoningDeltaEvent.type,
      data: reasoningDeltaEvent,
    },
    {
      event: messageDoneEvent.type,
      data: messageDoneEvent,
    },
    {
      event: completedEvent.type,
      data: completedEvent,
    },
  ];
};

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
type RuntimeResponseTerminalState = "open" | "failed";

/** Stateful encoder position for streaming runtime event conversion. */
interface RuntimeResponseState {
  readonly sequenceNumber: number;
  readonly outputIndex: number;
  readonly output: readonly RuntimeOutputItem[];
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

/** Builds a stable item id for a runtime event output item. */
const runtimeItemId = ({
  prefix,
  outputIndex,
}: {
  readonly prefix: string;
  readonly outputIndex: number;
}): string => `${prefix}_simulator_${outputIndex}`;

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
    outputIndex: 0,
    output: [],
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

/** Appends Responses SSE frames for one reasoning runtime event. */
const appendReasoningResponseEvents = ({
  events,
  output,
  runtimeEvent,
  outputIndex,
  sequenceNumber,
}: {
  readonly events: SseEvent[];
  readonly output: RuntimeOutputItem[];
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "ReasoningDelta" }>;
  readonly outputIndex: number;
  readonly sequenceNumber: number;
}): number => {
  const reasoningItem = {
    id: runtimeItemId({ prefix: "rs", outputIndex }),
    type: "reasoning",
    summary: [],
  } as const satisfies RuntimeReasoningItem;
  events.push({
    event: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      output_index: outputIndex,
      sequence_number: sequenceNumber,
      item: reasoningItem,
    } satisfies OpenAiSchema.ResponseStreamEvent,
  });
  events.push({
    event: "response.reasoning_summary_text.delta",
    data: {
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningItem.id,
      output_index: outputIndex,
      summary_index: 0,
      delta: runtimeEvent.text,
      sequence_number: sequenceNumber + 1,
    } satisfies OpenAiSchema.ResponseStreamEvent,
  });
  output.push(reasoningItem);
  return sequenceNumber + 2;
};

/** Appends Responses SSE frames for one assistant-message runtime event. */
const appendAssistantMessageResponseEvents = ({
  events,
  output,
  runtimeEvent,
  outputIndex,
  sequenceNumber,
}: {
  readonly events: SseEvent[];
  readonly output: RuntimeOutputItem[];
  readonly runtimeEvent: Extract<AgentRuntimeEvent, { readonly _tag: "AssistantMessage" }>;
  readonly outputIndex: number;
  readonly sequenceNumber: number;
}): number => {
  const messageItem = {
    id: runtimeItemId({ prefix: "msg", outputIndex }),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: runtimeEvent.text,
        annotations: [],
      },
    ],
  } as const satisfies RuntimeMessageItem;
  events.push({
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      output_index: outputIndex,
      sequence_number: sequenceNumber,
      item: messageItem,
    } satisfies OpenAiSchema.ResponseStreamEvent,
  });
  output.push(messageItem);
  return sequenceNumber + 1;
};

/** Appends Responses SSE frames for one normalized runtime event. */
const appendRuntimeResponseEvents = (input: {
  readonly events: SseEvent[];
  readonly output: RuntimeOutputItem[];
  readonly runtimeEvent: AgentRuntimeEvent;
  readonly outputIndex: number;
  readonly sequenceNumber: number;
}): number =>
  Match.valueTags(input.runtimeEvent, {
    ReasoningDelta: (runtimeEvent) => appendReasoningResponseEvents({ ...input, runtimeEvent }),
    AssistantMessage: (runtimeEvent) =>
      appendAssistantMessageResponseEvents({ ...input, runtimeEvent }),
  });

/** Converts one runtime event plus encoder state into SSE frames and next state. */
const runtimeEventToSseEvents = ({
  state,
  runtimeEvent,
}: {
  readonly state: RuntimeResponseState;
  readonly runtimeEvent: AgentRuntimeEvent;
}): readonly [RuntimeResponseState, readonly SseEvent[]] => {
  const events: SseEvent[] = [];
  const output = [...state.output];
  const sequenceNumber = appendRuntimeResponseEvents({
    events,
    output,
    runtimeEvent,
    outputIndex: state.outputIndex,
    sequenceNumber: state.sequenceNumber,
  });

  return [
    {
      sequenceNumber,
      outputIndex: state.outputIndex + 1,
      output,
      terminal: state.terminal,
    },
    events,
  ] as const;
};

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
    RuntimeEvent: ({ runtimeEvent }) => runtimeEventToSseEvents({ state, runtimeEvent }),
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
    Match.when("failed", (): readonly SseEvent[] => []),
    Match.orElse((): readonly SseEvent[] => [completedEventFromState({ request, state })]),
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
  const output: RuntimeOutputItem[] = [];
  const events: SseEvent[] = [
    {
      event: "response.created",
      data: {
        type: "response.created",
        response: createRuntimeResponse({ request, output }),
        sequence_number: 0,
      } satisfies OpenAiSchema.ResponseStreamEvent,
    },
  ];
  let sequenceNumber = 1;
  let outputIndex = 0;

  for (const runtimeEvent of runtimeEvents) {
    sequenceNumber = appendRuntimeResponseEvents({
      events,
      output,
      runtimeEvent,
      outputIndex,
      sequenceNumber,
    });
    outputIndex += 1;
  }

  events.push({
    event: "response.completed",
    data: {
      type: "response.completed",
      response: createRuntimeResponse({ request, output }),
      sequence_number: sequenceNumber,
    } satisfies OpenAiSchema.ResponseStreamEvent,
  });

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
