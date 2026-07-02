import assert from "node:assert/strict";

import { Schema } from "effect";

/** Minimal decoded Responses SSE frame shape used by assistant text assertions. */
export interface ResponseFrameWithData {
  readonly event: string;
  readonly data: unknown;
}

/** Schema used to distinguish assistant message completions from reasoning item completions. */
const AssistantMessageDoneData = Schema.Struct({
  item: Schema.Struct({ type: Schema.Literal("message") }),
});

/** Minimal failed Responses payload shape used by failure-contract assertions. */
const FailedResponseData = Schema.Struct({
  response: Schema.Struct({
    status: Schema.Literal("failed"),
    error: Schema.Struct({
      message: Schema.String,
    }),
  }),
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

/** Extracts the failed Responses error message from decoded Responses SSE frames. */
export const failedErrorMessageFromResponseFrames = (
  frames: readonly ResponseFrameWithData[],
): string => {
  const failed = frames.find((frame) => frame.event === "response.failed");
  assert.ok(failed, "missing response.failed event");
  return Schema.decodeUnknownSync(FailedResponseData)(failed.data).response.error.message;
};
