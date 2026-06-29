import { createHash } from "node:crypto";

import { Console, Effect, Match, Schema } from "effect";

/** Payload-safe telemetry fields for one ignored Claude SDK observation. */
export interface IgnoredClaudeSdkObservation {
  readonly shape: string;
  readonly payload: unknown;
  readonly sessionId?: string;
  readonly index?: number;
}

/** Returns whether one unknown value is a readonly string-keyed record. */
export const isReadonlyRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns whether one unknown value is a string. */
const isString = (value: unknown): value is string => typeof value === "string";

/** Returns a string value or undefined for one unknown SDK field. */
const optionalString = (value: unknown): string | undefined =>
  Match.value(value).pipe(
    Match.when(isString, (text) => text),
    Match.orElse(() => undefined),
  );

/** Reads one string field from an unknown SDK observation record. */
export const stringField = (value: unknown, field: string): string | undefined =>
  Match.value(value).pipe(
    Match.when(isReadonlyRecord, (record) => optionalString(record[field])),
    Match.orElse(() => undefined),
  );

/** Encodes an unknown SDK payload for length/hash telemetry without logging the encoded body. */
const encodedPayload = (payload: unknown): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)(payload);

/** Returns the SHA-256 digest of an ignored SDK payload without logging the payload. */
const payloadSha256 = (payload: string): string =>
  createHash("sha256").update(payload).digest("hex");

/** Encodes one ignored Claude SDK observation warning as a structured log line. */
const encodeIgnoredClaudeSdkObservationWarning = ({
  shape,
  payload,
  sessionId,
  index,
}: IgnoredClaudeSdkObservation): string => {
  const encoded = encodedPayload(payload);
  return Schema.encodeSync(Schema.UnknownFromJsonString)({
    event: "caara.claude_sdk.ignored_observation",
    level: "warn",
    provider: "claude",
    shape,
    sessionId,
    index,
    payloadLength: encoded.length,
    payloadSha256: payloadSha256(encoded),
  });
};

/** Logs payload-safe telemetry for one ignored Claude SDK observation. */
export const logIgnoredClaudeSdkObservation = Effect.fnUntraced(function* (
  observation: IgnoredClaudeSdkObservation,
) {
  yield* Console.log(encodeIgnoredClaudeSdkObservationWarning(observation));
});
