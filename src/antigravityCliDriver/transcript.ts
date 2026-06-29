import { createHash } from "node:crypto";

import { Console, Effect, Match, Option, Schema } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";
import type { AntigravityRelayMode } from "./options.ts";
import { runtimeEventsFromAntigravityTranscript } from "./transcriptRuntimeEvents.ts";

export {
  antigravityMissingFinalDiagnosticText,
  runtimeEventsFromAntigravityTranscript,
} from "./transcriptRuntimeEvents.ts";

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

/** Safe turn correlation metadata attached to transcript warning logs when available. */
export interface AntigravityTranscriptTelemetryContext {
  readonly threadId?: string;
  readonly turnId?: string;
}

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

/** Returns whether one schema-valid unsupported row is safe to ignore as an observation. */
const isIgnorableUnknownObservationRecord = (record: AntigravityTranscriptRecord): boolean =>
  !isSupportedTranscriptRecord(record);

/** Encodes one ignored Antigravity transcript row warning as a structured log line. */
const encodeIgnoredTranscriptRecordWarning = ({
  record,
  records,
  telemetryContext,
}: {
  readonly record: AntigravityTranscriptRecord;
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)({
    event: "caara.antigravity.transcript.ignored_record",
    level: "warn",
    provider: "antigravity",
    ...telemetryContext,
    source: record.source,
    type: record.type,
    status: record.status,
    shape: transcriptRecordShape(record),
    shapeCount: ignoredTranscriptRecordShapeCount({ records, record }),
    step_index: record.step_index,
    payloadLength: record.content?.length ?? 0,
    payloadSha256: payloadSha256(record.content ?? ""),
  });

/** Returns the stable source/type/status shape key for one Antigravity transcript row. */
const transcriptRecordShape = (record: AntigravityTranscriptRecord): string =>
  `${record.source}/${record.type}/${record.status}`;

/** Returns the SHA-256 digest of one ignored row payload without logging the payload. */
const payloadSha256 = (payload: string): string =>
  createHash("sha256").update(payload).digest("hex");

/** Counts ignored rows with the same source/type/status shape in one observed transcript chunk. */
const ignoredTranscriptRecordShapeCount = ({
  records,
  record,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly record: AntigravityTranscriptRecord;
}): number =>
  records.filter(
    (candidate) =>
      isIgnorableUnknownObservationRecord(candidate) &&
      transcriptRecordShape(candidate) === transcriptRecordShape(record),
  ).length;

/** Logs safe structured telemetry for ignored Antigravity transcript observation rows. */
const logIgnoredTranscriptRecords = Effect.fnUntraced(function* ({
  records,
  telemetryContext,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}) {
  for (const record of records.filter(isIgnorableUnknownObservationRecord)) {
    yield* Console.log(encodeIgnoredTranscriptRecordWarning({ record, records, telemetryContext }));
  }
});

/** Validates that one schema-decoded transcript record belongs to a supported event shape. */
const validateSupportedTranscriptRecord = Effect.fnUntraced(function* (
  record: AntigravityTranscriptRecord,
) {
  return yield* Match.value(isSupportedTranscriptRecord(record)).pipe(
    Match.when(true, () => Effect.succeed(record)),
    Match.when(
      () => isIgnorableUnknownObservationRecord(record),
      () => Effect.succeed(record),
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
  telemetryContext,
}: {
  readonly state: AntigravityTranscriptObservationState;
  readonly content: string;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
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
  yield* logIgnoredTranscriptRecords({ records: deduped.records, telemetryContext });
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
  telemetryContext,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
  readonly state: AntigravityTranscriptObservationState;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}) {
  const content = yield* readTranscriptContent({ fileSystem, transcriptPath });
  return yield* observeAntigravityTranscriptContent({ state, content, telemetryContext });
});

/** Reads and maps a completed Antigravity transcript into runtime events. */
export const readAntigravityTranscriptRuntimeEvents = Effect.fnUntraced(function* ({
  fileSystem,
  transcriptPath,
  state = emptyAntigravityTranscriptObservationState,
  reasoning,
  activity,
  telemetryContext,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
  readonly state?: AntigravityTranscriptObservationState;
  readonly reasoning?: AntigravityRelayMode;
  readonly activity?: AntigravityRelayMode;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}) {
  const observation = yield* readAntigravityTranscriptObservation({
    fileSystem,
    transcriptPath,
    state,
    telemetryContext,
  });
  return yield* runtimeEventsFromAntigravityTranscript({
    records: observation.records,
    reasoning,
    activity,
    telemetryContext,
  });
});
