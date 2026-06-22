import type * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";

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
