import { Effect, Match, Stream } from "effect";

import type { AgentRuntimeEvent } from "./agentDriver.ts";

/** Splits text into deterministic non-empty chunks bounded by the requested chunk count. */
const textChunks = ({
  text,
  chunkCount,
}: {
  readonly text: string;
  readonly chunkCount: number;
}): readonly string[] => {
  const chunkSize = Math.ceil(text.length / chunkCount);
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
};

/** Builds assistant text events with caller-controlled delta chunking. */
export const createChunkedAssistantTextRuntimeEvents = ({
  itemId,
  text,
  chunkCount,
}: {
  readonly itemId: string;
  readonly text: string;
  readonly chunkCount: number;
}): readonly AgentRuntimeEvent[] => [
  {
    _tag: "ItemCreated",
    itemId,
    itemKind: "assistant_message",
  },
  {
    _tag: "ContentStarted",
    itemId,
    contentIndex: 0,
    contentKind: "assistant_text",
  },
  ...textChunks({ text, chunkCount }).map(
    (chunk): AgentRuntimeEvent => ({
      _tag: "ContentDelta",
      itemId,
      contentIndex: 0,
      contentKind: "assistant_text",
      text: chunk,
    }),
  ),
  {
    _tag: "ContentCompleted",
    itemId,
    contentIndex: 0,
    contentKind: "assistant_text",
  },
  {
    _tag: "ItemCompleted",
    itemId,
  },
];

/** Builds one runtime event effect with optional delay applied only to text deltas. */
const delayedRuntimeEvent = ({
  event,
  delayMs,
}: {
  readonly event: AgentRuntimeEvent;
  readonly delayMs: number;
}) => {
  const eventEffect = Effect.succeed(event);
  const delayedEventEffect = Effect.delay(eventEffect, `${delayMs} millis`);
  return Match.value(event._tag === "ContentDelta" && delayMs > 0).pipe(
    Match.when(true, () => delayedEventEffect),
    Match.orElse(() => eventEffect),
  );
};

/** Applies configured inter-delta delay to content deltas while preserving event order. */
export const withConfiguredDelay = ({
  events,
  delayMs,
}: {
  readonly events: readonly AgentRuntimeEvent[];
  readonly delayMs: number;
}): Stream.Stream<AgentRuntimeEvent, never> =>
  Stream.fromIterable(events).pipe(
    Stream.mapEffect((event) => delayedRuntimeEvent({ event, delayMs })),
  );
