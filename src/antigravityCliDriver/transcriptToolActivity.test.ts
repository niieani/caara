import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import type { AgentRuntimeEvent } from "../mockResponsesProvider/agentDriver.ts";
import {
  emptyAntigravityTranscriptObservationState,
  observeAntigravityTranscriptContent,
  runtimeEventsFromAntigravityTranscript,
} from "./transcript.ts";

/** Current repository root used to exercise repo-relative Antigravity path labels. */
const projectRoot = process.cwd();

/** Runtime content-delta event narrowed from the driver-neutral event union. */
type AgentRuntimeContentDelta = Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;

/** Builds one JSONL row from a transcript fixture object. */
const recordLine = (record: Readonly<Record<string, unknown>>): string =>
  `${Schema.encodeSync(Schema.UnknownFromJsonString)(record)}\n`;

/** Builds optional planner tool-call fixture fields. */
const toolCallFields = (
  toolCalls: readonly Readonly<Record<string, unknown>>[] | undefined,
): Readonly<Record<string, unknown>> =>
  Option.match(Option.fromUndefinedOr(toolCalls), {
    onNone: () => ({}),
    onSome: (value) => ({ tool_calls: value }),
  });

/** Minimal completed planner response record used by activity mapping tests. */
const plannerRecord = ({
  stepIndex,
  content,
  toolCalls,
}: {
  readonly stepIndex: number;
  readonly content: string;
  readonly toolCalls?: readonly Readonly<Record<string, unknown>>[];
}): Readonly<Record<string, unknown>> => ({
  step_index: stepIndex,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status: "DONE",
  created_at: "2026-06-23T03:09:01Z",
  content,
  ...toolCallFields(toolCalls),
});

/** Minimal completed Antigravity tool-result record used by correlation tests. */
const toolResultRecord = ({
  stepIndex,
  type,
  content,
}: {
  readonly stepIndex: number;
  readonly type: string;
  readonly content: string;
}): Readonly<Record<string, unknown>> => ({
  step_index: stepIndex,
  source: "MODEL",
  type,
  status: "DONE",
  created_at: "2026-06-23T03:09:01Z",
  content,
});

/** Decodes JSONL fixtures through the same transcript observer used by the driver. */
const decodeFixtureRecords = Effect.fnUntraced(function* (
  records: readonly Readonly<Record<string, unknown>>[],
) {
  const observed = yield* observeAntigravityTranscriptContent({
    state: emptyAntigravityTranscriptObservationState,
    content: records.map(recordLine).join(""),
  });
  return observed.records;
});

/** Returns whether a runtime event is a content delta. */
const isContentDelta = (event: AgentRuntimeEvent): event is AgentRuntimeContentDelta =>
  event._tag === "ContentDelta";

/** Builds a lookup of item creation metadata by runtime item id. */
const itemCreatedById = (events: readonly AgentRuntimeEvent[]) =>
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
    .filter(isContentDelta)
    .filter((event) => items.get(event.itemId)?.transportVisibility !== "relay_only")
    .map((event) => event.text);
};

describe("Antigravity transcript tool activity", () => {
  it.effect("maps real nested Antigravity tool args and correlates completed result rows", () =>
    Effect.gen(function* () {
      const records = yield* decodeFixtureRecords([
        plannerRecord({
          stepIndex: 0,
          content: "Inspecting workspace",
          toolCalls: [
            {
              name: "list_dir",
              args: {
                DirectoryPath: projectRoot,
                toolAction: "Listing root directory",
                toolSummary: "Root directory listing",
              },
            },
            {
              name: "run_command",
              args: {
                CommandLine:
                  'find src -type f \\( -name "*.test.ts" -o -name "*.tst.ts" \\) -print0 | xargs -0 wc -l',
                Cwd: projectRoot,
                WaitMsBeforeAsync: 3000,
                toolAction: "Counting test lines of code",
                toolSummary: "LOC of test files",
              },
            },
            {
              name: "view_file",
              args: {
                AbsolutePath: `${projectRoot}/CONTEXT.md`,
                toolAction: "Viewing CONTEXT.md",
                toolSummary: "Viewing CONTEXT.md",
              },
            },
          ],
        }),
        toolResultRecord({
          stepIndex: 1,
          type: "LIST_DIRECTORY",
          content: "RAW_DIRECTORY_ENTRIES_SHOULD_NOT_LEAK",
        }),
        toolResultRecord({
          stepIndex: 2,
          type: "RUN_COMMAND",
          content:
            "Created At: 2026-06-24T06:41:34Z\nCompleted At: 2026-06-24T06:41:34Z\nThe command completed successfully.\nOutput:\nRAW_COMMAND_OUTPUT_SHOULD_NOT_LEAK",
        }),
        toolResultRecord({
          stepIndex: 3,
          type: "VIEW_FILE",
          content: "RAW_FILE_CONTENT_SHOULD_NOT_LEAK",
        }),
        plannerRecord({
          stepIndex: 4,
          content: "Final answer",
        }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });
      const visibleText = visibleContentDeltaTexts({ events: runtimeEvents }).join("\n");

      assert.ok(!visibleText.includes("RAW_DIRECTORY_ENTRIES_SHOULD_NOT_LEAK"));
      assert.ok(!visibleText.includes("RAW_COMMAND_OUTPUT_SHOULD_NOT_LEAK"));
      assert.ok(!visibleText.includes("RAW_FILE_CONTENT_SHOULD_NOT_LEAK"));
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Listing `.`",
        'Running command: `find src -type f \\( -name "*.test.ts" -o -name "*.tst.ts" \\) -print0 | xargs -0 wc -l`',
        "Viewing `CONTEXT.md`",
        "Command completed",
        "Final answer",
      ]);
    }),
  );

  it.effect("maps failed correlated command results without leaking command output", () =>
    Effect.gen(function* () {
      const records = yield* decodeFixtureRecords([
        plannerRecord({
          stepIndex: 0,
          content: "Running failing command",
          toolCalls: [
            {
              name: "run_command",
              args: {
                CommandLine: "bun run missing-script",
              },
            },
          ],
        }),
        toolResultRecord({
          stepIndex: 1,
          type: "RUN_COMMAND",
          content: "The command failed.\nOutput:\nRAW_FAILURE_OUTPUT_SHOULD_NOT_LEAK",
        }),
        plannerRecord({
          stepIndex: 2,
          content: "Final answer",
        }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });
      const visibleText = visibleContentDeltaTexts({ events: runtimeEvents }).join("\n");

      assert.ok(!visibleText.includes("RAW_FAILURE_OUTPUT_SHOULD_NOT_LEAK"));
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Running command: `bun run missing-script`",
        "Command failed",
        "Final answer",
      ]);
    }),
  );
});
