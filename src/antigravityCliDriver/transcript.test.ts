import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestConsole } from "effect/testing";

import type {
  AgentRuntimeContentKind,
  AgentRuntimeEvent,
  AgentRuntimeItemCreated,
} from "../mockResponsesProvider/agentDriver.ts";
import {
  antigravityMissingFinalDiagnosticText,
  emptyAntigravityTranscriptObservationState,
  observeAntigravityTranscriptContent,
  runtimeEventsFromAntigravityTranscript,
} from "./transcript.ts";

/** Runtime content-delta event narrowed from the driver-neutral event union. */
type AgentRuntimeContentDelta = Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;

/** Fixture object values used by transcript JSONL record builders. */
type FixtureRecordValue =
  | string
  | readonly Readonly<Record<string, unknown>>[]
  | Readonly<Record<string, unknown>>;

/** Optional fixture object entry before undefined fields are dropped. */
type OptionalRecordField = readonly [string, FixtureRecordValue | undefined];

/** Fixture object entry after undefined fields are dropped. */
type DefinedRecordField = readonly [string, FixtureRecordValue];

/** Returns whether one optional fixture object field has a concrete value. */
const hasDefinedRecordFieldValue = (field: OptionalRecordField): field is DefinedRecordField =>
  field[1] !== undefined;

/** Builds optional fixture object fields without imperative branching. */
const optionalRecordFields = (
  fields: readonly OptionalRecordField[],
): Readonly<Record<string, unknown>> =>
  Object.fromEntries<unknown>(fields.filter(hasDefinedRecordFieldValue));

/** Builds one realistic Antigravity transcript JSONL record. */
const recordLine = (record: Readonly<Record<string, unknown>>): string =>
  `${Schema.encodeSync(Schema.UnknownFromJsonString)(record)}\n`;

/** Minimal completed planner response record used by transcript observation tests. */
const plannerRecord = ({
  stepIndex,
  content,
  thinking,
  toolCalls,
}: {
  readonly stepIndex: number;
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly Readonly<Record<string, unknown>>[];
}): Readonly<Record<string, unknown>> => ({
  step_index: stepIndex,
  source: "MODEL",
  type: "PLANNER_RESPONSE",
  status: "DONE",
  created_at: "2026-06-23T03:09:01Z",
  content,
  ...optionalRecordFields([
    ["thinking", thinking],
    ["tool_calls", toolCalls],
  ]),
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

/** Minimal system record ignored by user-visible transcript mapping. */
const systemRecord = ({
  stepIndex,
  type,
  content,
}: {
  readonly stepIndex: number;
  readonly type: string;
  readonly content: string;
}): Readonly<Record<string, unknown>> => ({
  step_index: stepIndex,
  source: "SYSTEM",
  type,
  status: "DONE",
  created_at: "2026-06-23T03:09:01Z",
  content,
});

/** Minimal completed Antigravity tool-result record used by activity mapping tests. */
const toolResultRecord = ({
  stepIndex,
  type,
  path,
  filePath,
  command,
  content,
  toolSummary,
  toolAction,
  payload,
}: {
  readonly stepIndex: number;
  readonly type: string;
  readonly path?: string;
  readonly filePath?: string;
  readonly command?: string;
  readonly content?: string;
  readonly toolSummary?: string;
  readonly toolAction?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> => ({
  step_index: stepIndex,
  source: "MODEL",
  type,
  status: "DONE",
  created_at: "2026-06-23T03:09:01Z",
  ...optionalRecordFields([
    ["path", path],
    ["file_path", filePath],
    ["command", command],
    ["content", content],
    ["toolSummary", toolSummary],
    ["toolAction", toolAction],
    ["payload", payload],
  ]),
});

/** Decodes JSONL fixture objects through the same transcript observer used by the driver. */
const decodeFixtureRecords = Effect.fnUntraced(function* (
  records: readonly Readonly<Record<string, unknown>>[],
) {
  const observed = yield* observeAntigravityTranscriptContent({
    state: emptyAntigravityTranscriptObservationState,
    content: records.map(recordLine).join(""),
  });
  return observed.records;
});

/** Returns whether a runtime event is a content delta of the requested kind. */
const isContentDeltaOfKind = (
  event: AgentRuntimeEvent,
  contentKind: AgentRuntimeContentKind,
): event is AgentRuntimeContentDelta =>
  event._tag === "ContentDelta" && event.contentKind === contentKind;

/** Returns whether a runtime event is an assistant commentary item creation. */
const isCommentaryItemCreated = (event: AgentRuntimeEvent): event is AgentRuntimeItemCreated =>
  event._tag === "ItemCreated" && event.messagePhase === "commentary";

/** Returns all content-delta texts for one runtime content kind. */
const contentDeltaTexts = ({
  events,
  contentKind,
}: {
  readonly events: readonly AgentRuntimeEvent[];
  readonly contentKind: AgentRuntimeContentKind;
}): readonly string[] =>
  events.filter((event) => isContentDeltaOfKind(event, contentKind)).map((event) => event.text);

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

  it.effect("fails explicitly on malformed JSONL", () =>
    Effect.gen(function* () {
      const malformed = yield* Effect.flip(
        observeAntigravityTranscriptContent({
          state: emptyAntigravityTranscriptObservationState,
          content: "{not-json}\n",
        }),
      );
      assert.match(malformed.message, /Malformed Antigravity transcript_full\.jsonl record/u);
    }),
  );

  it.effect("logs safe telemetry for schema-valid unknown observation rows", () =>
    Effect.gen(function* () {
      const observed = yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        telemetryContext: {
          threadId: "thread-unknown-shape",
          turnId: "turn-unknown-shape",
        },
        content: recordLine({
          step_index: 0,
          source: "MODEL",
          type: "UNKNOWN_REQUIRED_EVENT",
          status: "DONE",
          created_at: "2026-06-23T03:09:01Z",
        }),
      });
      const logText = (yield* TestConsole.logLines).join("\n");

      assert.strictEqual(observed.records.length, 1);
      assert.ok(logText.includes('"provider":"antigravity"'));
      assert.ok(logText.includes('"shape":"MODEL/UNKNOWN_REQUIRED_EVENT/DONE"'));
      assert.ok(logText.includes('"payloadLength":0'));
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

  it.effect("accepts unknown model result rows without making the turn fail", () =>
    Effect.gen(function* () {
      const observed = yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        content: [
          recordLine(
            plannerRecord({
              stepIndex: 0,
              content: "Listing tasks",
              toolCalls: [
                {
                  name: "manage_task",
                  args: {
                    Action: "list",
                    toolAction: "Listing background tasks",
                    toolSummary: "List tasks",
                  },
                },
              ],
            }),
          ),
          recordLine({
            step_index: 1,
            source: "MODEL",
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-06-24T07:11:53Z",
            content:
              "Created At: 2026-06-24T07:11:53Z\nCompleted At: 2026-06-24T07:11:53Z\nNo background tasks are currently running.",
          }),
          recordLine(plannerRecord({ stepIndex: 2, content: "No background tasks are running." })),
        ].join(""),
      });

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({
        records: observed.records,
      });
      const visibleText = visibleContentDeltaTexts({ events: runtimeEvents }).join("\n");
      const logLines = yield* TestConsole.logLines;

      assert.ok(!visibleText.includes("Created At:"));
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Listing background tasks",
        "No background tasks are running.",
      ]);
      assert.ok(
        logLines.some(
          (line) =>
            typeof line === "string" &&
            line.includes('"event":"caara.antigravity.transcript.ignored_record"') &&
            line.includes('"level":"warn"') &&
            line.includes('"type":"GENERIC"'),
        ),
      );
    }),
  );

  it.effect("logs safe telemetry for ignored unknown model result rows", () =>
    Effect.gen(function* () {
      const rawIgnoredContent = ["RAW_UNKNOWN_TOOL_RESULT", "SHOULD_NOT_LEAK"].join("_");
      yield* observeAntigravityTranscriptContent({
        state: emptyAntigravityTranscriptObservationState,
        telemetryContext: {
          threadId: "thread-ignored-row",
          turnId: "turn-ignored-row",
        },
        content: [
          recordLine({
            step_index: 0,
            source: "MODEL",
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-06-24T07:11:53Z",
            content: rawIgnoredContent,
          }),
          recordLine({
            step_index: 1,
            source: "MODEL",
            type: "GENERIC",
            status: "DONE",
            created_at: "2026-06-24T07:11:54Z",
            content: rawIgnoredContent,
          }),
        ].join(""),
      });

      const logLines = yield* TestConsole.logLines;
      const ignoredLogs = logLines.filter(
        (line): line is string =>
          typeof line === "string" &&
          line.includes('"event":"caara.antigravity.transcript.ignored_record"'),
      );
      const logText = ignoredLogs.join("\n");

      assert.strictEqual(ignoredLogs.length, 2);
      assert.ok(logText.includes('"threadId":"thread-ignored-row"'));
      assert.ok(logText.includes('"turnId":"turn-ignored-row"'));
      assert.ok(logText.includes('"shape":"MODEL/GENERIC/DONE"'));
      assert.ok(logText.includes('"shapeCount":2'));
      assert.ok(logText.includes('"payloadLength":39'));
      assert.match(logText, /"payloadSha256":"[a-f0-9]{64}"/u);
      assert.ok(!logText.includes(rawIgnoredContent));
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

describe("Antigravity transcript runtime mapping", () => {
  it.effect("maps displayable Antigravity thinking to reasoning by default", () =>
    Effect.gen(function* () {
      const records = yield* decodeFixtureRecords([
        plannerRecord({
          stepIndex: 0,
          content: "Final answer",
          thinking: "Inspect the repository, then answer.",
        }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });

      assert.deepStrictEqual(
        contentDeltaTexts({ events: runtimeEvents, contentKind: "reasoning_summary_text" }),
        ["Inspect the repository, then answer."],
      );
      assert.deepStrictEqual(
        contentDeltaTexts({ events: runtimeEvents, contentKind: "assistant_text" }),
        ["Final answer"],
      );
    }),
  );

  it.effect("suppresses Antigravity reasoning when reasoning relay is disabled", () =>
    Effect.gen(function* () {
      const records = yield* decodeFixtureRecords([
        plannerRecord({
          stepIndex: 0,
          content: "Final answer still visible",
          thinking: "Do not relay this reasoning.",
        }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({
        records,
        reasoning: "off",
      });

      assert.deepStrictEqual(
        contentDeltaTexts({ events: runtimeEvents, contentKind: "reasoning_summary_text" }),
        [],
      );
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Final answer still visible",
      ]);
    }),
  );

  it.effect("maps Antigravity tool calls and tool results to terse activity commentary", () =>
    Effect.gen(function* () {
      const records = yield* decodeFixtureRecords([
        plannerRecord({
          stepIndex: 0,
          content: "Inspecting source",
          toolCalls: [{ id: "call-list", name: "LIST_DIRECTORY", path: "src" }],
        }),
        toolResultRecord({
          stepIndex: 1,
          type: "VIEW_FILE",
          filePath: "src/server.ts",
          content: "FULL_FILE_CONTENT_SHOULD_NOT_LEAK",
        }),
        toolResultRecord({
          stepIndex: 2,
          type: "RUN_COMMAND",
          command: "bun lint",
          content: "RAW_COMMAND_OUTPUT_SHOULD_NOT_LEAK",
        }),
        plannerRecord({
          stepIndex: 3,
          content: "Task complete",
          thinking: "Need to inspect source before answering.",
        }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });

      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Listing `src`",
        "Viewing `src/server.ts`",
        "Running command: `bun lint`",
        "Need to inspect source before answering.",
        "Task complete",
      ]);
    }),
  );

  it.effect(
    "returns a safe diagnostic final answer for tool activity without a final planner response",
    () =>
      Effect.gen(function* () {
        const records = yield* decodeFixtureRecords([
          plannerRecord({
            stepIndex: 0,
            content: "Inspecting source",
            toolCalls: [{ id: "call-list", name: "LIST_DIRECTORY", path: "src" }],
          }),
        ]);

        const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({
          records,
          telemetryContext: {
            threadId: "thread-missing-final",
            turnId: "turn-missing-final",
          },
        });
        const logText = (yield* TestConsole.logLines).join("\n");

        assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
          "Listing `src`",
          antigravityMissingFinalDiagnosticText(),
        ]);
        assert.ok(
          runtimeEvents.some((event) => event._tag === "TurnSucceeded"),
          "expected diagnostic final to complete the turn",
        );
        assert.ok(
          logText.includes('"event":"caara.antigravity.transcript.missing_final_response"'),
        );
        assert.ok(logText.includes('"threadId":"thread-missing-final"'));
        assert.ok(logText.includes('"turnId":"turn-missing-final"'));
      }),
  );

  it.effect("falls back for blank commands and preserves code fences safely", () =>
    Effect.gen(function* () {
      const records = yield* decodeFixtureRecords([
        toolResultRecord({ stepIndex: 0, type: "RUN_COMMAND", command: "   " }),
        toolResultRecord({
          stepIndex: 1,
          type: "RUN_COMMAND",
          command: "printf '```'\ntrue",
        }),
        plannerRecord({ stepIndex: 2, content: "Final answer" }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });

      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Running command",
        "Running command:\n````bash\nprintf '```'\ntrue\n````",
        "Final answer",
      ]);
    }),
  );

  it.effect("hides activity commentary when activity relay is disabled", () =>
    Effect.gen(function* () {
      const records = yield* decodeFixtureRecords([
        plannerRecord({
          stepIndex: 0,
          content: "Inspecting source",
          toolCalls: [{ id: "call-search", name: "GREP_SEARCH", path: "src" }],
        }),
        toolResultRecord({ stepIndex: 1, type: "VIEW_FILE", filePath: "src/server.ts" }),
        plannerRecord({
          stepIndex: 2,
          content: "Final answer remains",
        }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({
        records,
        activity: "off",
      });
      const commentaryItems = runtimeEvents.filter(isCommentaryItemCreated);

      assert.deepStrictEqual(
        commentaryItems.map((event) => event.transportVisibility),
        ["relay_only", "relay_only"],
      );
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Final answer remains",
      ]);
    }),
  );

  it.effect("filters non-visible records and never relays raw unsafe payload text", () =>
    Effect.gen(function* () {
      const unsafeStrings = [
        "RAW_TRANSCRIPT_JSON_SHOULD_NOT_LEAK",
        "ANTIGRAVITY_LOG_LINE_SHOULD_NOT_LEAK",
        "SQLITE_ROW_SHOULD_NOT_LEAK",
        "FULL_TOOL_PAYLOAD_SHOULD_NOT_LEAK",
      ] as const;
      const records = yield* decodeFixtureRecords([
        userRecord(0),
        systemRecord({
          stepIndex: 1,
          type: "CHECKPOINT",
          content: unsafeStrings[0],
        }),
        systemRecord({
          stepIndex: 2,
          type: "CONVERSATION_HISTORY",
          content: unsafeStrings[1],
        }),
        plannerRecord({
          stepIndex: 3,
          content: "Running checks",
          toolCalls: [
            {
              id: "call-run",
              name: "RUN_COMMAND",
              command: "bun run test",
              payload: { raw: unsafeStrings[3] },
            },
          ],
        }),
        toolResultRecord({
          stepIndex: 4,
          type: "VIEW_FILE",
          filePath: "src/private.ts",
          content: unsafeStrings[2],
          toolSummary: "Reading src/private.ts",
          payload: { raw: unsafeStrings[3] },
        }),
        plannerRecord({
          stepIndex: 5,
          content: "Public final answer",
          thinking: "Public reasoning summary",
        }),
      ]);

      const runtimeEvents = yield* runtimeEventsFromAntigravityTranscript({ records });
      const visibleText = visibleContentDeltaTexts({ events: runtimeEvents }).join("\n");

      for (const unsafeString of unsafeStrings) {
        assert.ok(!visibleText.includes(unsafeString), unsafeString);
      }
      assert.deepStrictEqual(visibleContentDeltaTexts({ events: runtimeEvents }), [
        "Running command: `bun run test`",
        "Viewing `src/private.ts`",
        "Public reasoning summary",
        "Public final answer",
      ]);
    }),
  );
});
