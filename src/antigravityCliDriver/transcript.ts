import { Effect, Option, Schema } from "effect";
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
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AntigravityTranscriptRecord))(
    line,
  ).pipe(
    Effect.mapError(
      () =>
        new AgentDriverError({
          message: "Malformed Antigravity transcript_full.jsonl record.",
        }),
    ),
  );
});

/** Decodes transcript JSONL lines into validated Antigravity transcript records. */
const decodeTranscriptRecords = Effect.fnUntraced(function* (content: string) {
  const lines = content.split("\n").filter((line) => line.length > 0);
  return yield* Effect.forEach(lines, decodeTranscriptLine);
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

/** Reads and maps a completed Antigravity transcript into runtime events. */
export const readAntigravityTranscriptRuntimeEvents = Effect.fnUntraced(function* ({
  fileSystem,
  transcriptPath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
}) {
  const content = yield* readTranscriptContent({ fileSystem, transcriptPath });
  const records = yield* decodeTranscriptRecords(content);
  return yield* runtimeEventsFromAntigravityTranscript({ records });
});
