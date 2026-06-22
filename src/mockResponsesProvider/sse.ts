import { Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";

/** Single Server-Sent Event frame emitted by the mock Responses provider. */
export interface SseEvent {
  readonly event: string;
  readonly data: Schema.Json;
}

/** Encodes a JSON-compatible SSE data payload through Effect Schema. */
export const encodeSseData = (data: Schema.Json): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)(data);

/** Encodes one event as an SSE frame using Effect's native SSE encoder. */
export const encodeSseEvent = ({ event, data }: SseEvent): string =>
  Sse.encoder.write({
    _tag: "Event",
    event,
    id: undefined,
    data: encodeSseData(data),
  });

/** Converts an event sequence into an Effect stream of UTF-8 SSE bytes. */
export const encodeSseStream = (events: readonly SseEvent[]): Stream.Stream<Uint8Array> =>
  Stream.fromIterable(events.map(encodeSseEvent)).pipe(Stream.encodeText);
