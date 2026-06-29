import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestConsole } from "effect/testing";

import type {
  AgentRuntimeContentKind,
  AgentRuntimeEvent,
  AgentRuntimeItemCreated,
} from "../mockResponsesProvider/agentDriver.ts";
import {
  emptyAntigravityTranscriptObservationState,
  observeAntigravityTranscriptContent,
  runtimeEventsFromAntigravityTranscript,
} from "./transcript.ts";

/** Redacted Antigravity transcript fixture names replayed through the real mapper. */
type TranscriptReplayFixtureName =
  | "hegel-manage-task-generic.transcript_full.jsonl"
  | "hegel-known-result-out-of-order.transcript_full.jsonl"
  | "hegel-run-command-running.transcript_full.jsonl";

/** Runtime content-delta event narrowed from the driver-neutral event union. */
type AgentRuntimeContentDelta = Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;

/** Directory containing redacted real-shape Antigravity transcript replay fixtures. */
const fixtureDirectory = path.join(process.cwd(), "src", "antigravityCliDriver", "fixtures");

/** Test fixture failure for transcript replay setup. */
class TranscriptReplayTestError extends Schema.TaggedErrorClass<TranscriptReplayTestError>()(
  "TranscriptReplayTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture read failures into a typed replay test error. */
const transcriptReplayTestError = (cause: unknown): TranscriptReplayTestError =>
  new TranscriptReplayTestError({ message: String(cause) });

/** Reads one committed redacted Antigravity transcript replay fixture. */
const readTranscriptReplayFixture = Effect.fnUntraced(function* (
  name: TranscriptReplayFixtureName,
) {
  return yield* Effect.tryPromise({
    try: () => fs.readFile(path.join(fixtureDirectory, name), "utf8"),
    catch: transcriptReplayTestError,
  });
});

/** Decodes one JSONL fixture through the same transcript observer used by the driver. */
const decodeTranscriptReplayFixture = Effect.fnUntraced(function* (
  name: TranscriptReplayFixtureName,
) {
  const content = yield* readTranscriptReplayFixture(name);
  const observed = yield* observeAntigravityTranscriptContent({
    state: emptyAntigravityTranscriptObservationState,
    content,
  });
  return observed.records;
});

/** Returns whether a runtime event is a content delta of the requested kind. */
const isContentDeltaOfKind = (
  event: AgentRuntimeEvent,
  contentKind: AgentRuntimeContentKind,
): event is AgentRuntimeContentDelta =>
  event._tag === "ContentDelta" && event.contentKind === contentKind;

/** Builds a lookup of item creation metadata by runtime item id. */
const itemCreatedById = (
  events: readonly AgentRuntimeEvent[],
): ReadonlyMap<string, AgentRuntimeItemCreated> =>
  new Map(
    events.filter((event) => event._tag === "ItemCreated").map((event) => [event.itemId, event]),
  );

/** Returns content-delta texts that would be visible in the Responses stream. */
const visibleContentDeltaTexts = ({
  events,
}: {
  readonly events: readonly AgentRuntimeEvent[];
}): readonly string[] => {
  const items = itemCreatedById(events);
  return events
    .filter((event): event is AgentRuntimeContentDelta => event._tag === "ContentDelta")
    .filter((event) => items.get(event.itemId)?.transportVisibility !== "relay_only")
    .map((event) => event.text);
};

/** Returns all content-delta texts for one runtime content kind. */
const contentDeltaTexts = ({
  events,
  contentKind,
}: {
  readonly events: readonly AgentRuntimeEvent[];
  readonly contentKind: AgentRuntimeContentKind;
}): readonly string[] =>
  events.filter((event) => isContentDeltaOfKind(event, contentKind)).map((event) => event.text);

/** Redacted unknown RUNNING-row payload fragments that must not reach visible output or logs. */
const unsafeRunCommandRunningFragments = [
  "RAW_TASK_ID_SHOULD_NOT_LEAK",
  "transcript_full.jsonl",
  ".gemini/antigravity-cli/brain",
  "RAW_TASK_LOG_PATH_SHOULD_NOT_LEAK",
  "RAW_COMMAND_OUTPUT_PAYLOAD_SHOULD_NOT_LEAK",
] as const;

describe("Antigravity transcript replay fixtures", () => {
  it.effect("replays the Hegel manage_task GENERIC result shape without raw payload leakage", () =>
    Effect.gen(function* () {
      const records = yield* decodeTranscriptReplayFixture(
        "hegel-manage-task-generic.transcript_full.jsonl",
      );
      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });
      const visibleText = visibleContentDeltaTexts({ events: runtimeEvents }).join("\n");
      const logText = (yield* TestConsole.logLines).join("\n");

      assert.deepStrictEqual(
        records.map((record) => record.step_index),
        [0, 1, 3, 2, 4],
      );
      assert.ok(!visibleText.includes("RAW_MANAGE_TASK_RESULT_SHOULD_NOT_LEAK"));
      assert.ok(!visibleText.includes("REDACTED_CONVERSATION_HISTORY_SHOULD_NOT_LEAK"));
      assert.ok(!logText.includes("RAW_MANAGE_TASK_RESULT_SHOULD_NOT_LEAK"));
      assert.deepStrictEqual(
        contentDeltaTexts({ events: runtimeEvents, contentKind: "reasoning_summary_text" }),
        ["Check background task list before answering."],
      );
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Listing background tasks",
        "Check background task list before answering.",
        "No background tasks are running.",
      ]);
      assert.ok(logText.includes('"event":"caara.antigravity.transcript.ignored_record"'));
      assert.ok(logText.includes('"type":"GENERIC"'));
    }),
  );

  it.effect(
    "replays a known tool result appended before its planner call without payload leakage",
    () =>
      Effect.gen(function* () {
        const records = yield* decodeTranscriptReplayFixture(
          "hegel-known-result-out-of-order.transcript_full.jsonl",
        );
        const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });
        const visibleText = visibleContentDeltaTexts({ events: runtimeEvents }).join("\n");

        assert.deepStrictEqual(
          records.map((record) => record.step_index),
          [0, 2, 1, 3],
        );
        assert.ok(!visibleText.includes("RAW_DIRECTORY_ENTRIES_SHOULD_NOT_LEAK"));
        assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
          "Listing `src`",
          "Inspect top-level source directories before summarizing.",
          "Project structure summarized.",
        ]);
      }),
  );

  it.effect("replays a nonterminal run_command observation without raw payload leakage", () =>
    Effect.gen(function* () {
      const content = yield* readTranscriptReplayFixture(
        "hegel-run-command-running.transcript_full.jsonl",
      );
      const observed = yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        content,
        telemetryContext: {
          threadId: "thread-run-command-running",
          turnId: "turn-run-command-running",
        },
      });
      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({
        records: observed.records,
      });
      const visibleText = visibleContentDeltaTexts({ events: runtimeEvents }).join("\n");
      const logText = (yield* TestConsole.logLines).join("\n");

      assert.deepStrictEqual(
        observed.records.map((record) => record.step_index),
        [0, 1, 2, 3],
      );
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Running command: `sleep 60`",
        "Confirm command observation is nonterminal before final answer.",
        "Command started; final answer still delivered.",
      ]);
      assert.ok(logText.includes('"event":"caara.antigravity.transcript.ignored_record"'));
      assert.ok(logText.includes('"shape":"MODEL/RUN_COMMAND/RUNNING"'));
      assert.ok(logText.includes('"threadId":"thread-run-command-running"'));
      assert.ok(logText.includes('"turnId":"turn-run-command-running"'));
      assert.match(logText, /"payloadSha256":"[a-f0-9]{64}"/u);
      for (const unsafeFragment of unsafeRunCommandRunningFragments) {
        assert.ok(!visibleText.includes(unsafeFragment), unsafeFragment);
        assert.ok(!logText.includes(unsafeFragment), unsafeFragment);
      }
    }),
  );
});
