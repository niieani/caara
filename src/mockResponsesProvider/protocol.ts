import { Effect, Schema } from "effect";

/** Stable mock output fixture emitted for every supported Responses request. */
export const mockResponsesFixture = {
  reasoningText: "thinking how best to respond",
  assistantText: "Yes, the mock subagent seems to be working",
  responseId: "resp_mock_subagent",
  reasoningItemId: "rs_mock_subagent",
  messageItemId: "msg_mock_subagent",
  createdAtEpochSeconds: 1,
} as const satisfies Schema.Json;

/** Minimal streaming Responses request shape supported by this mock provider. */
export const responsesCreateRequestSchema = Schema.Struct({
  model: Schema.String,
  input: Schema.Json,
  stream: Schema.Literal(true),
});

/** Minimal decoded streaming Responses request accepted by this mock provider. */
export type ResponsesCreateRequest = typeof responsesCreateRequestSchema.Type;

/** Decodes untrusted JSON into the supported streaming Responses request shape. */
export const decodeResponsesCreateRequest = Effect.fnUntraced(function* (body: Schema.Json) {
  return yield* Schema.decodeUnknownEffect(responsesCreateRequestSchema)(body);
});
