import assert from "node:assert/strict";

import type * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { Schema } from "effect";

/** Minimal decoded Responses SSE frame shape used by assistant text assertions. */
export interface ResponseFrameWithData {
  readonly event: string;
  readonly data: OpenAiSchema.ResponseStreamEvent;
}

/** Schema used to distinguish assistant message completions from reasoning item completions. */
const AssistantMessageDoneData = Schema.Struct({
  item: Schema.Struct({ type: Schema.Literal("message") }),
});

/** Returns whether a Responses frame data payload is a completed assistant message item. */
export const isAssistantMessageDoneData = Schema.is(AssistantMessageDoneData);

/** Extracts the completed assistant text from decoded Responses SSE frames. */
export const assistantTextFromResponseFrames = (
  frames: readonly ResponseFrameWithData[],
): string => {
  const messageDone = frames.find(
    (frame) =>
      frame.event === "response.output_item.done" && isAssistantMessageDoneData(frame.data),
  );
  assert.ok(messageDone, "missing assistant message done event");
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      item: Schema.Struct({
        content: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    }),
  )(messageDone.data);
  const content = decoded.item.content.at(0);
  assert.ok(content, "missing assistant content");
  return content.text;
};
