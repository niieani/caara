import { assert, describe, it } from "@effect/vitest";

import { AgentDriverError, type AgentRuntimeEvent } from "./agentDriver.ts";
import type { ResponsesCreateRequest } from "./protocol.ts";
import { createResponseEventsFromRuntimeEvents } from "./responseEvents.ts";

/** Stable Responses request used by runtime lifecycle encoder tests. */
const request = {
  model: "claude/test",
  input: [],
  stream: true,
} satisfies ResponsesCreateRequest;

/** Returns SSE event names in emission order. */
const eventNames = (events: readonly { readonly event: string }[]): readonly string[] =>
  events.map((event) => event.event);

/** Returns how many terminal Responses events were emitted. */
const terminalEventCount = (events: readonly { readonly event: string }[]): number =>
  events.filter(
    (event) => event.event === "response.completed" || event.event === "response.failed",
  ).length;

/** Finds one emitted SSE event by event name. */
const findEvent = <T extends { readonly event: string }>(
  events: readonly T[],
  eventName: string,
): T => {
  const event = events.find((candidate) => candidate.event === eventName);
  assert.ok(event, `missing event ${eventName}`);
  return event;
};

/** Runtime lifecycle for one complete assistant text item. */
const completeTextLifecycle: readonly AgentRuntimeEvent[] = [
  {
    _tag: "ItemCreated",
    itemId: "runtime-message-1",
    itemKind: "assistant_message",
  },
  {
    _tag: "ContentStarted",
    itemId: "runtime-message-1",
    contentIndex: 0,
    contentKind: "assistant_text",
  },
  {
    _tag: "ContentDelta",
    itemId: "runtime-message-1",
    contentIndex: 0,
    contentKind: "assistant_text",
    text: "hello",
  },
  {
    _tag: "ContentCompleted",
    itemId: "runtime-message-1",
    contentIndex: 0,
    contentKind: "assistant_text",
  },
  {
    _tag: "ItemCompleted",
    itemId: "runtime-message-1",
  },
  {
    _tag: "TurnSucceeded",
  },
];

/** Runtime lifecycle for one complete public reasoning summary item. */
const completeReasoningLifecycle: readonly AgentRuntimeEvent[] = [
  {
    _tag: "ItemCreated",
    itemId: "runtime-reasoning-1",
    itemKind: "reasoning",
  },
  {
    _tag: "ContentStarted",
    itemId: "runtime-reasoning-1",
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
  },
  {
    _tag: "ContentDelta",
    itemId: "runtime-reasoning-1",
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
    text: "thinking",
  },
  {
    _tag: "ContentCompleted",
    itemId: "runtime-reasoning-1",
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
  },
  {
    _tag: "ItemCompleted",
    itemId: "runtime-reasoning-1",
  },
  {
    _tag: "TurnSucceeded",
  },
];

/** Runtime lifecycle for partial reasoning followed by a terminal driver failure. */
const failedAfterPartialLifecycle: readonly AgentRuntimeEvent[] = [
  {
    _tag: "ItemCreated",
    itemId: "runtime-reasoning-failed",
    itemKind: "reasoning",
  },
  {
    _tag: "ContentStarted",
    itemId: "runtime-reasoning-failed",
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
  },
  {
    _tag: "ContentDelta",
    itemId: "runtime-reasoning-failed",
    contentIndex: 0,
    contentKind: "reasoning_summary_text",
    text: "partial",
  },
  {
    _tag: "TurnFailed",
    error: new AgentDriverError({ message: "runtime failed after partial output" }),
  },
];

describe("runtime lifecycle events", () => {
  it("encodes a complete assistant text lifecycle with one terminal success", () => {
    const events = createResponseEventsFromRuntimeEvents({
      request,
      runtimeEvents: completeTextLifecycle,
    });

    assert.deepStrictEqual(eventNames(events), [
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.deepStrictEqual(findEvent(events, "response.output_text.delta").data, {
      type: "response.output_text.delta",
      item_id: "runtime-message-1",
      output_index: 0,
      content_index: 0,
      delta: "hello",
      sequence_number: 2,
    });
    assert.strictEqual(terminalEventCount(events), 1);
  });

  it("encodes a complete reasoning lifecycle with one terminal success", () => {
    const events = createResponseEventsFromRuntimeEvents({
      request,
      runtimeEvents: completeReasoningLifecycle,
    });

    assert.deepStrictEqual(eventNames(events), [
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.strictEqual(eventNames(events).includes("response.output_text.delta"), false);
    assert.deepStrictEqual(findEvent(events, "response.output_item.done").data, {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 5,
      item: {
        id: "runtime-reasoning-1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thinking" }],
      },
    });
    assert.strictEqual(terminalEventCount(events), 1);
  });

  it("encodes terminal failure after partial output without converting it to success", () => {
    const events = createResponseEventsFromRuntimeEvents({
      request,
      runtimeEvents: failedAfterPartialLifecycle,
    });

    assert.deepStrictEqual(eventNames(events), [
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.failed",
    ]);
    assert.strictEqual(terminalEventCount(events), 1);
  });
});
