import { Effect, Match, Option, Schema } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import {
  AgentDriverError,
  type AgentRuntimeEvent,
  createAssistantTextRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";

/** Minimal Antigravity transcript record shape needed for first-turn final output. */
const AntigravityTranscriptRecord = Schema.Struct({
  step_index: Schema.Finite,
  source: Schema.String,
  type: Schema.String,
  status: Schema.String,
  content: Schema.optional(Schema.String),
});

/** Minimal Antigravity transcript record shape needed for first-turn final output. */
export type AntigravityTranscriptRecord = typeof AntigravityTranscriptRecord.Type;

/** In-memory observation state for append-only Antigravity transcript snapshots. */
export interface AntigravityTranscriptObservationState {
  readonly observedContent: string;
  readonly observedBytes: number;
  readonly bufferedLine: string;
  readonly observedStepIndexes: readonly number[];
}

/** Result of observing one Antigravity transcript snapshot. */
export interface AntigravityTranscriptObservation {
  readonly state: AntigravityTranscriptObservationState;
  readonly records: readonly AntigravityTranscriptRecord[];
}

/** Initial in-memory observation state for a new Antigravity transcript. */
export const emptyAntigravityTranscriptObservationState = {
  observedContent: "",
  observedBytes: 0,
  bufferedLine: "",
  observedStepIndexes: [],
} as const satisfies AntigravityTranscriptObservationState;

/** Builds the canonical Antigravity full transcript path for one conversation id. */
export const antigravityTranscriptFullPath = ({
  pathService,
  homeDir,
  conversationId,
}: {
  readonly pathService: Path.Path;
  readonly homeDir: string;
  readonly conversationId: string;
}): string =>
  pathService.join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );

/** Reads the transcript file content or fails with the driver-owned missing-transcript message. */
const readTranscriptContent = Effect.fnUntraced(function* ({
  fileSystem,
  transcriptPath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
}) {
  return yield* fileSystem.readFileString(transcriptPath).pipe(
    Effect.mapError(
      () =>
        new AgentDriverError({
          message: "Antigravity transcript_full.jsonl was not created.",
        }),
    ),
  );
});

/** Decodes one newline-complete transcript JSONL row through the Antigravity schema. */
const decodeTranscriptLine = Effect.fnUntraced(function* (line: string) {
  const record = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AntigravityTranscriptRecord),
  )(line).pipe(
    Effect.mapError(
      () =>
        new AgentDriverError({
          message: "Malformed Antigravity transcript_full.jsonl record.",
        }),
    ),
  );
  return yield* validateSupportedTranscriptRecord(record);
});

/** Returns the final completed planner response content, if present. */
const finalPlannerContentOption = (
  records: readonly AntigravityTranscriptRecord[],
): Option.Option<string> =>
  Option.fromUndefinedOr(
    records
      .filter(
        (record) =>
          record.source === "MODEL" &&
          record.type === "PLANNER_RESPONSE" &&
          record.status === "DONE" &&
          record.content !== undefined,
      )
      .map((record) => record.content)
      .at(-1),
  );

/** Returns whether one Antigravity record shape is supported by the current driver contract. */
const isSupportedTranscriptRecord = (record: AntigravityTranscriptRecord): boolean =>
  [
    record.source === "MODEL" && record.type === "PLANNER_RESPONSE" && record.status === "DONE",
    record.source === "MODEL" &&
      ["LIST_DIRECTORY", "VIEW_FILE", "RUN_COMMAND", "GREP_SEARCH"].some(
        (type) => type === record.type,
      ) &&
      record.status === "DONE",
    record.source === "USER_EXPLICIT" && record.type === "USER_INPUT" && record.status === "DONE",
    record.source === "SYSTEM" &&
      ["CONVERSATION_HISTORY", "CHECKPOINT", "SYSTEM_MESSAGE"].some(
        (type) => type === record.type,
      ) &&
      record.status === "DONE",
  ].some(Boolean);

/** Validates that one schema-decoded transcript record belongs to a supported event shape. */
const validateSupportedTranscriptRecord = Effect.fnUntraced(function* (
  record: AntigravityTranscriptRecord,
) {
  return yield* Match.value(isSupportedTranscriptRecord(record)).pipe(
    Match.when(true, () => Effect.succeed(record)),
    Match.orElse(() =>
      Effect.fail(
        new AgentDriverError({
          message: `Unsupported Antigravity transcript record: ${record.source}/${record.type}/${record.status}.`,
        }),
      ),
    ),
  );
});

/** Fails when a transcript snapshot no longer appends to the previous observed content. */
const validateAppendOnlySnapshot = Effect.fnUntraced(function* ({
  state,
  content,
}: {
  readonly state: AntigravityTranscriptObservationState;
  readonly content: string;
}) {
  const appendOnly =
    content.length >= state.observedBytes && content.startsWith(state.observedContent);
  return yield* Option.match(Option.fromUndefinedOr([appendOnly].filter(Boolean).at(0)), {
    onNone: () =>
      Effect.fail(
        new AgentDriverError({
          message: "Antigravity transcript_full.jsonl was rewritten or truncated.",
        }),
      ),
    onSome: () => Effect.void,
  });
});

/** Splits appended JSONL content into complete lines and one buffered trailing line. */
const splitCompleteJsonlLines = ({
  combined,
}: {
  readonly combined: string;
}): {
  readonly completeLines: readonly string[];
  readonly bufferedLine: string;
} => {
  const lineParts = combined.split("\n");
  const completeLines = lineParts.slice(0, -1).filter((line) => line.length > 0);
  const bufferedLine = Match.value(combined.endsWith("\n")).pipe(
    Match.when(true, () => ""),
    Match.orElse(() => lineParts.at(-1) ?? ""),
  );
  return { completeLines, bufferedLine };
};

/** Adds one record to a transcript observation accumulator unless its step index is already seen. */
const addUniqueRecord = (
  accumulator: {
    readonly records: readonly AntigravityTranscriptRecord[];
    readonly observedStepIndexes: readonly number[];
  },
  record: AntigravityTranscriptRecord,
): {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly observedStepIndexes: readonly number[];
} =>
  Match.value(accumulator.observedStepIndexes.includes(record.step_index)).pipe(
    Match.when(true, () => accumulator),
    Match.orElse(() => ({
      records: [...accumulator.records, record],
      observedStepIndexes: [...accumulator.observedStepIndexes, record.step_index],
    })),
  );

/** Observes one full Antigravity transcript snapshot and emits only complete unseen records. */
export const observeAntigravityTranscriptContent = Effect.fnUntraced(function* ({
  state,
  content,
}: {
  readonly state: AntigravityTranscriptObservationState;
  readonly content: string;
}) {
  yield* validateAppendOnlySnapshot({ state, content });
  const appended = content.slice(state.observedBytes);
  const combined = `${state.bufferedLine}${appended}`;
  const { completeLines, bufferedLine } = splitCompleteJsonlLines({ combined });
  const decodedRecords = yield* Effect.forEach(completeLines, decodeTranscriptLine);
  const deduped = decodedRecords.reduce(addUniqueRecord, {
    records: [],
    observedStepIndexes: state.observedStepIndexes,
  });
  return {
    records: deduped.records,
    state: {
      observedContent: content,
      observedBytes: content.length,
      bufferedLine,
      observedStepIndexes: deduped.observedStepIndexes,
    },
  } satisfies AntigravityTranscriptObservation;
});

/** Converts validated Antigravity transcript records into first-turn runtime events. */
export const runtimeEventsFromAntigravityTranscript = Effect.fnUntraced(function* ({
  records,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
}) {
  const content = yield* Option.match(finalPlannerContentOption(records), {
    onNone: () =>
      Effect.fail(
        new AgentDriverError({
          message: "Antigravity transcript did not contain a completed final model response.",
        }),
      ),
    onSome: Effect.succeed,
  });
  return [
    ...createAssistantTextRuntimeEvents({
      itemId: "msg_antigravity_cli_final",
      text: content,
      messagePhase: "final_answer",
    }),
    createRuntimeTurnSucceededEvent(),
  ] satisfies readonly AgentRuntimeEvent[];
});

/** Reads one transcript snapshot and observes it from the supplied append-only state. */
export const readAntigravityTranscriptObservation = Effect.fnUntraced(function* ({
  fileSystem,
  transcriptPath,
  state,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
  readonly state: AntigravityTranscriptObservationState;
}) {
  const content = yield* readTranscriptContent({ fileSystem, transcriptPath });
  return yield* observeAntigravityTranscriptContent({ state, content });
});

/** Reads and maps a completed Antigravity transcript into runtime events. */
export const readAntigravityTranscriptRuntimeEvents = Effect.fnUntraced(function* ({
  fileSystem,
  transcriptPath,
  state = emptyAntigravityTranscriptObservationState,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
  readonly state?: AntigravityTranscriptObservationState;
}) {
  const observation = yield* readAntigravityTranscriptObservation({
    fileSystem,
    transcriptPath,
    state,
  });
  return yield* runtimeEventsFromAntigravityTranscript({ records: observation.records });
});
