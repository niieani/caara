import { Console, Effect, Match, Option, Schema } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";
import type { AntigravityRelayMode } from "./options.ts";
import { runtimeEventsFromAntigravityTranscript } from "./transcriptRuntimeEvents.ts";

export { runtimeEventsFromAntigravityTranscript } from "./transcriptRuntimeEvents.ts";

/** Safe nested Antigravity tool-call args allowed to influence activity text. */
const AntigravityToolArgs = Schema.Struct({
  CommandLine: Schema.optional(Schema.String),
  Cwd: Schema.optional(Schema.String),
  AbsolutePath: Schema.optional(Schema.String),
  DirectoryPath: Schema.optional(Schema.String),
  FilePath: Schema.optional(Schema.String),
  FilePaths: Schema.optional(Schema.Array(Schema.String)),
  Pattern: Schema.optional(Schema.String),
  Query: Schema.optional(Schema.String),
  toolSummary: Schema.optional(Schema.String),
  toolAction: Schema.optional(Schema.String),
});

/** Safe Antigravity tool-call metadata fields allowed to influence activity text. */
const AntigravityToolMetadata = Schema.Struct({
  name: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  toolSummary: Schema.optional(Schema.String),
  toolAction: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(AntigravityToolArgs),
});

/** Antigravity transcript record shape accepted by the driver-owned mapper. */
const AntigravityTranscriptRecord = Schema.Struct({
  step_index: Schema.Finite,
  source: Schema.String,
  type: Schema.String,
  status: Schema.String,
  content: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(AntigravityToolMetadata)),
  name: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  toolSummary: Schema.optional(Schema.String),
  toolAction: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(AntigravityToolArgs),
});

/** Antigravity transcript record shape accepted by the driver-owned mapper. */
export type AntigravityTranscriptRecord = typeof AntigravityTranscriptRecord.Type;

/** Antigravity model result row types with first-class runtime activity mapping. */
const supportedModelResultRecordTypes = [
  "LIST_DIRECTORY",
  "VIEW_FILE",
  "RUN_COMMAND",
  "GREP_SEARCH",
] as const;

/** Antigravity system rows that are intentionally ignored by runtime mapping. */
const supportedSystemRecordTypes = [
  "CONVERSATION_HISTORY",
  "CHECKPOINT",
  "SYSTEM_MESSAGE",
] as const;

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

/** Returns whether one Antigravity record shape is supported by the current driver contract. */
const isSupportedTranscriptRecord = (record: AntigravityTranscriptRecord): boolean =>
  [
    record.source === "MODEL" && record.type === "PLANNER_RESPONSE" && record.status === "DONE",
    record.source === "MODEL" &&
      supportedModelResultRecordTypes.some((type) => type === record.type) &&
      record.status === "DONE",
    record.source === "USER_EXPLICIT" && record.type === "USER_INPUT" && record.status === "DONE",
    record.source === "SYSTEM" &&
      supportedSystemRecordTypes.some((type) => type === record.type) &&
      record.status === "DONE",
  ].some(Boolean);

/** Returns whether one unknown model row is safe to ignore as an opaque tool result. */
const isIgnorableUnknownModelResultRecord = (record: AntigravityTranscriptRecord): boolean =>
  record.source === "MODEL" &&
  record.status === "DONE" &&
  record.content !== undefined &&
  record.type !== "PLANNER_RESPONSE" &&
  !supportedModelResultRecordTypes.some((type) => type === record.type);

/** Encodes one ignored Antigravity transcript row warning as a structured log line. */
const encodeIgnoredTranscriptRecordWarning = (record: AntigravityTranscriptRecord): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)({
    event: "caara.antigravity.transcript.ignored_record",
    level: "warn",
    source: record.source,
    type: record.type,
    status: record.status,
    step_index: record.step_index,
  });

/** Logs and accepts an unknown Antigravity model result row that should not fail the turn. */
const acceptIgnoredTranscriptRecord = Effect.fnUntraced(function* (
  record: AntigravityTranscriptRecord,
) {
  yield* Console.log(encodeIgnoredTranscriptRecordWarning(record));
  return record;
});

/** Validates that one schema-decoded transcript record belongs to a supported event shape. */
const validateSupportedTranscriptRecord = Effect.fnUntraced(function* (
  record: AntigravityTranscriptRecord,
) {
  return yield* Match.value(isSupportedTranscriptRecord(record)).pipe(
    Match.when(true, () => Effect.succeed(record)),
    Match.when(
      () => isIgnorableUnknownModelResultRecord(record),
      () => acceptIgnoredTranscriptRecord(record),
    ),
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
  reasoning,
  activity,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
  readonly state?: AntigravityTranscriptObservationState;
  readonly reasoning?: AntigravityRelayMode;
  readonly activity?: AntigravityRelayMode;
}) {
  const observation = yield* readAntigravityTranscriptObservation({
    fileSystem,
    transcriptPath,
    state,
  });
  return yield* runtimeEventsFromAntigravityTranscript({
    records: observation.records,
    reasoning,
    activity,
  });
});
