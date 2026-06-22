import type * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";

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

/** Appends Responses SSE frames for one normalized runtime event. */
const appendRuntimeResponseEvents = ({
  events,
  output,
  runtimeEvent,
  outputIndex,
  sequenceNumber,
}: {
  readonly events: SseEvent[];
  readonly output: RuntimeOutputItem[];
  readonly runtimeEvent: AgentRuntimeEvent;
  readonly outputIndex: number;
  readonly sequenceNumber: number;
}): number => {
  switch (runtimeEvent._tag) {
    case "ReasoningDelta": {
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
    }
    case "AssistantMessage": {
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
    }
  }
};

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
