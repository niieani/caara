import { Effect, Schema } from "effect";

import { createServerErrorAgentDriverError } from "../mockResponsesProvider/agentDriver.ts";
import {
  makeDriverResumeCursor,
  type DriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";

/** Versioned driver-owned Antigravity resume cursor stored opaquely by Caara. */
const AntigravityDriverResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  conversationId: Schema.NonEmptyString,
});

/** Versioned driver-owned Antigravity resume cursor stored opaquely by Caara. */
export type AntigravityDriverResumeCursor = typeof AntigravityDriverResumeCursor.Type;

/** Encodes an Antigravity conversation id into an opaque Caara driver resume cursor string. */
export const makeAntigravityDriverResumeCursor = ({
  conversationId,
}: {
  readonly conversationId: string;
}): DriverResumeCursor =>
  makeDriverResumeCursor(
    Schema.encodeSync(Schema.UnknownFromJsonString)(
      AntigravityDriverResumeCursor.make({
        schemaVersion: 1,
        conversationId,
      }),
    ),
  );

/** Decodes the Antigravity-owned cursor shape and fails closed on malformed versions. */
export const decodeAntigravityDriverResumeCursor = Effect.fnUntraced(function* (cursor: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AntigravityDriverResumeCursor))(
    cursor,
  ).pipe(
    Effect.mapError(() =>
      createServerErrorAgentDriverError({
        message: "Malformed Antigravity driver resume cursor.",
      }),
    ),
  );
});
