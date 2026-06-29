import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { CaaraAppLogWriter } from "../caaraLogging.ts";
import {
  emptyAntigravityTranscriptObservationState,
  observeAntigravityTranscriptContent,
  runtimeEventsFromAntigravityTranscript,
} from "./transcript.ts";

/** Encodes one fixture transcript record as a JSONL line. */
const recordLine = (record: Readonly<Record<string, unknown>>): string =>
  `${Schema.encodeSync(Schema.UnknownFromJsonString)(record)}\n`;

/** Builds an in-memory app log layer for runtime telemetry assertions. */
const appLogCaptureLayer = ({ lines }: { readonly lines: string[] }) =>
  Layer.succeed(CaaraAppLogWriter, {
    writeLine: Effect.fnUntraced(function* (line: string) {
      lines.push(line);
      yield* Effect.void;
    }),
  });

describe("Antigravity transcript app logging", () => {
  it.effect("writes ignored observation telemetry to the app-owned log when available", () =>
    Effect.gen(function* () {
      const appLogLines: string[] = [];

      yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        telemetryContext: {
          threadId: "thread-app-log-unknown-shape",
          turnId: "turn-app-log-unknown-shape",
        },
        content: recordLine({
          step_index: 0,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-06-23T03:09:01Z",
          content: "RAW_UNKNOWN_TOOL_RESULT_SHOULD_NOT_LEAK",
        }),
      }).pipe(Effect.provide(appLogCaptureLayer({ lines: appLogLines })));

      const appLogText = appLogLines.join("\n");

      assert.ok(appLogText.includes('"event":"caara.antigravity.transcript.ignored_record"'));
      assert.ok(appLogText.includes('"threadId":"thread-app-log-unknown-shape"'));
      assert.ok(!appLogText.includes("RAW_UNKNOWN_TOOL_RESULT_SHOULD_NOT_LEAK"));
    }),
  );

  it.effect("writes missing-final telemetry to the app-owned log when available", () =>
    Effect.gen(function* () {
      const appLogLines: string[] = [];
      const observed = yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        content: recordLine({
          step_index: 0,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-06-23T03:09:01Z",
          content: "Inspecting source",
          tool_calls: [{ id: "call-list", name: "LIST_DIRECTORY", path: "src" }],
        }),
      });

      yield* runtimeEventsFromAntigravityTranscript({
        records: observed.records,
        telemetryContext: {
          threadId: "thread-app-log-missing-final",
          turnId: "turn-app-log-missing-final",
        },
      }).pipe(Effect.provide(appLogCaptureLayer({ lines: appLogLines })));
      const appLogText = appLogLines.join("\n");

      assert.ok(
        appLogText.includes('"event":"caara.antigravity.transcript.missing_final_response"'),
      );
      assert.ok(appLogText.includes('"threadId":"thread-app-log-missing-final"'));
    }),
  );
});
