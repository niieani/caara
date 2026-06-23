import type * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";

import { mockResponsesFixture, type ResponsesCreateRequest } from "./protocol.ts";
import type { SseEvent } from "./sse.ts";

/** Reasoning summary text block emitted in a completed reasoning item. */
export interface RuntimeSummaryTextContent {
  readonly type: "summary_text";
  readonly text: string;
}

/** Assistant output text block emitted in a completed message item. */
export interface RuntimeOutputTextContent {
  readonly type: "output_text";
  readonly text: string;
  readonly annotations: readonly [];
}

/** Minimal reasoning output item emitted into the Responses stream. */
export interface RuntimeReasoningItem {
  readonly id: string;
  readonly type: "reasoning";
  readonly summary: readonly RuntimeSummaryTextContent[];
}

/** Minimal assistant message output item emitted into the Responses stream. */
export interface RuntimeMessageItem {
  readonly id: string;
  readonly type: "message";
  readonly status: "in_progress" | "completed";
  readonly role: "assistant";
  readonly content: readonly RuntimeOutputTextContent[];
}

/** Concrete output item union emitted by the runtime event encoder. */
export type RuntimeOutputItem = RuntimeReasoningItem | RuntimeMessageItem;

/** Terminal state tracked while converting runtime events into Responses frames. */
export type RuntimeResponseTerminalState = "open" | "succeeded" | "failed";

/** Runtime item state accumulated until the item is completed or terminal output is emitted. */
export interface RuntimeItemState {
  readonly itemId: string;
  readonly itemKind: "assistant_message" | "reasoning";
  readonly outputIndex: number;
  readonly text: string;
}

/** Stateful encoder position for streaming runtime event conversion. */
export interface RuntimeResponseState {
  readonly sequenceNumber: number;
  readonly nextOutputIndex: number;
  readonly output: readonly RuntimeOutputItem[];
  readonly items: readonly RuntimeItemState[];
  readonly terminal: RuntimeResponseTerminalState;
}

/** Builds a minimal Responses object for the current stream state. */
export const createRuntimeResponse = ({
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
export const initialRuntimeResponseState = ({
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
export const createReasoningItem = ({
  itemId,
  text = "",
}: {
  readonly itemId: string;
  readonly text?: string;
}): RuntimeReasoningItem => ({
  id: itemId,
  type: "reasoning",
  summary: [text]
    .filter((summaryText) => summaryText.length > 0)
    .map((summaryText) => ({ type: "summary_text", text: summaryText })),
});

/** Builds an assistant message item for Responses output. */
export const createMessageItem = ({
  itemId,
  status,
  text,
}: {
  readonly itemId: string;
  readonly status: RuntimeMessageItem["status"];
  readonly text: string;
}): RuntimeMessageItem => ({
  id: itemId,
  type: "message",
  status,
  role: "assistant",
  content: [text]
    .filter((contentText) => contentText.length > 0)
    .map((contentText) => ({
      type: "output_text",
      text: contentText,
      annotations: [],
    })),
});

/** Looks up the current state for one runtime item id. */
export const runtimeItemState = ({
  items,
  itemId,
}: {
  readonly items: readonly RuntimeItemState[];
  readonly itemId: string;
}): RuntimeItemState | undefined => items.find((item) => item.itemId === itemId);

/** Replaces or inserts one runtime item state by item id. */
export const upsertRuntimeItemState = ({
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
export const completedEventFromState = ({
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
export const failedEventFromState = ({
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
