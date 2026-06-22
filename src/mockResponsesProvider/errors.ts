import { Schema } from "effect";

/** Request validation failure returned as a clear HTTP 400 response. */
export class InvalidResponsesRequest extends Schema.TaggedErrorClass<InvalidResponsesRequest>()(
  "InvalidResponsesRequest",
  {
    message: Schema.String,
  },
) {}
