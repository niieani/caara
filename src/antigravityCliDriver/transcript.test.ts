import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  emptyAntigravityTranscriptObservationState,
  observeAntigravityTranscriptContent,
  runtimeEventsFromAntigravityTranscript,
} from "./transcript.ts";

/** Builds one realistic Antigravity transcript JSONL record. */
const recordLine = (record: Readonly<Record<string, unknown>>): string =>
  `${Schema.encodeSync(Schema.UnknownFromJsonString)(record)}\n`;

/** Minimal completed planner response record used by transcript observation tests. */
const plannerRecord = ({
  stepIndex,
  content,
}: {
  readonly stepIndex: number;
  readonly content: string;
}): Readonly<Record<string, unknown>> => ({
  step_index: stepIndex,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status: "DONE",
  created_at: "2026-06-23T03:09:01Z",
  content,
});

/** Minimal user input record ignored by final assistant output mapping. */
const userRecord = (stepIndex: number): Readonly<Record<string, unknown>> => ({
  step_index: stepIndex,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  status: "DONE",
  created_at: "2026-06-23T03:09:01Z",
  content: "<USER_REQUEST>\nping\n</USER_REQUEST>",
});

describe("Antigravity transcript observation", () => {
  it.effect("buffers newline-incomplete JSONL until the record is complete", () =>
    Effect.gen(function* () {
      const line = recordLine(plannerRecord({ stepIndex: 0, content: "pong" }));
      const partial = line.slice(0, -1);
      const first = yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        content: partial,
      });

      assert.deepStrictEqual(first.records, []);
      assert.strictEqual(first.state.bufferedLine, partial);

      const second = yield* observeAntigravityTranscriptContent({
        state: first.state,
        content: line,
      });
      assert.strictEqual(second.records.length, 1);
      assert.strictEqual(second.state.bufferedLine, "");
    }),
  );

  it.effect("fails explicitly on malformed JSONL and unknown transcript shapes", () =>
    Effect.gen(function* () {
      const malformed = yield* Effect.flip(
        observeAntigravityTranscriptContent({
          state: emptyAntigravityTranscriptObservationState,
          content: "{not-json}\n",
        }),
      );
      assert.match(malformed.message, /Malformed Antigravity transcript_full\.jsonl record/u);

      const unknownShape = yield* Effect.flip(
        observeAntigravityTranscriptContent({
          state: emptyAntigravityTranscriptObservationState,
          content: recordLine({
            step_index: 0,
            source: "MODEL",
            type: "UNKNOWN_REQUIRED_EVENT",
            status: "DONE",
            created_at: "2026-06-23T03:09:01Z",
          }),
        }),
      );
      assert.match(unknownShape.message, /Unsupported Antigravity transcript record/u);
    }),
  );

  it.effect("deduplicates repeated transcript records by step_index", () =>
    Effect.gen(function* () {
      const observed = yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        content: [
          recordLine(userRecord(0)),
          recordLine(plannerRecord({ stepIndex: 1, content: "first" })),
          recordLine(plannerRecord({ stepIndex: 1, content: "duplicate" })),
        ].join(""),
      });

      assert.deepStrictEqual(
        observed.records.map((record) => record.step_index),
        [0, 1],
      );
      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({
        records: observed.records,
      });
      assert.deepStrictEqual(
        runtimeEvents.filter((event) => event._tag === "ContentDelta").map((event) => event.text),
        ["first"],
      );
    }),
  );

  it.effect("fails when a transcript snapshot is truncated or rewritten", () =>
    Effect.gen(function* () {
      const first = yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        content: recordLine(userRecord(0)),
      });

      const truncated = yield* Effect.flip(
        observeAntigravityTranscriptContent({
          state: first.state,
          content: "",
        }),
      );
      assert.match(truncated.message, /rewritten or truncated/u);

      const rewritten = yield* Effect.flip(
        observeAntigravityTranscriptContent({
          state: first.state,
          content: recordLine(userRecord(1)),
        }),
      );
      assert.match(rewritten.message, /rewritten or truncated/u);
    }),
  );
});
