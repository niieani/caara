import { Effect, Match, Option, Schema, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import {
  createInvalidPromptAgentDriverError,
  type AgentCancellationOutcome,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentDriverError,
  type AgentRuntimeEvent,
  createRuntimeTurnSucceededEvent,
} from "./agentDriver.ts";
import { diagnosticDriverFixture } from "./diagnosticDriverFixtures.ts";
import { createChunkedAssistantTextRuntimeEvents } from "./diagnosticDriverRuntimeEvents.ts";
import type { ExternalSessionState } from "./sessionDirectory.ts";

/** Responses content or input item represented as a decoded JSON object. */
type ResponseRecord = Readonly<Record<string, unknown>>;

/** JSON-safe summary item emitted by diagnostic/echo for one current-turn content block. */
type DiagnosticEchoContentSummary =
  | {
      readonly type: "input_text";
      readonly text: string;
    }
  | {
      readonly type: "input_image";
      readonly image_url: string;
    }
  | {
      readonly type: "input_file";
      readonly path: string;
    };

/** Generic object schema used before current-turn-specific diagnostic echo validation. */
const responseRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

/** Responses message item shape accepted by the Diagnostic echo extractor. */
const responseInputMessageSchema = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("user"),
  content: Schema.Array(responseRecordSchema),
});

/** Responses input shape accepted by the Diagnostic echo extractor. */
const responseInputSchema = Schema.Array(responseInputMessageSchema);

/** Builds an explicit Diagnostic echo extraction failure. */
const diagnosticEchoError = (message: string): AgentDriverError =>
  createInvalidPromptAgentDriverError({ message });

/** Reads a string property from a decoded Responses record. */
const stringProperty = ({
  name,
  record,
}: {
  readonly name: string;
  readonly record: ResponseRecord;
}): Option.Option<string> =>
  Option.fromUndefinedOr(record[name]).pipe(
    Option.filter((value): value is string => typeof value === "string"),
  );

/** Reads the first available string property from a decoded Responses record. */
const firstStringProperty = ({
  names,
  record,
}: {
  readonly names: readonly string[];
  readonly record: ResponseRecord;
}): Option.Option<string> =>
  Option.fromUndefinedOr(
    names
      .flatMap((name) =>
        Option.match(stringProperty({ name, record }), {
          onNone: () => [],
          onSome: (value) => [value],
        }),
      )
      .at(0),
  );

/** Returns the single normalized user message expected at the driver boundary. */
const singleCurrentUserMessage = Effect.fnUntraced(function* (
  messages: readonly (typeof responseInputMessageSchema.Type)[],
) {
  const message = yield* Option.match(Option.fromUndefinedOr(messages.at(0)), {
    onNone: () => diagnosticEchoError("Diagnostic echo requires a current user message."),
    onSome: Effect.succeed,
  });
  yield* Match.value(messages.length).pipe(
    Match.when(1, () => Effect.void),
    Match.orElse(() =>
      Effect.fail(
        diagnosticEchoError("Diagnostic echo requires exactly one normalized user message."),
      ),
    ),
  );
  return message;
});

/** Summarizes one supported Diagnostic echo text content block. */
const echoSummaryFromTextContent = Effect.fnUntraced(function* (content: ResponseRecord) {
  const text = yield* Option.match(stringProperty({ name: "text", record: content }), {
    onNone: () => diagnosticEchoError("Diagnostic echo input_text content requires text."),
    onSome: Effect.succeed,
  });
  return { type: "input_text", text } satisfies DiagnosticEchoContentSummary;
});

/** Summarizes one supported Diagnostic echo image content block. */
const echoSummaryFromImageContent = Effect.fnUntraced(function* (content: ResponseRecord) {
  yield* Option.match(stringProperty({ name: "file_id", record: content }), {
    onNone: () => Effect.void,
    onSome: () =>
      diagnosticEchoError(
        "Diagnostic echo input_image file_id is unsupported without a fetch/decode path.",
      ),
  });
  const imageUrl = yield* Option.match(stringProperty({ name: "image_url", record: content }), {
    onNone: () => diagnosticEchoError("Diagnostic echo input_image content requires image_url."),
    onSome: Effect.succeed,
  });
  return { type: "input_image", image_url: imageUrl } satisfies DiagnosticEchoContentSummary;
});

/** Summarizes one supported Diagnostic echo file content block. */
const echoSummaryFromFileContent = Effect.fnUntraced(function* (content: ResponseRecord) {
  yield* Option.match(stringProperty({ name: "file_id", record: content }), {
    onNone: () => Effect.void,
    onSome: () =>
      diagnosticEchoError(
        "Diagnostic echo input_file file_id is unsupported without a fetch/decode path.",
      ),
  });
  const filePath = yield* Option.match(
    firstStringProperty({ names: ["file_path", "path"], record: content }),
    {
      onNone: () =>
        diagnosticEchoError("Diagnostic echo input_file content requires file_path or path."),
      onSome: Effect.succeed,
    },
  );
  return { type: "input_file", path: filePath } satisfies DiagnosticEchoContentSummary;
});

/** Summarizes one current-turn Responses content item for Diagnostic echo output. */
const echoSummaryFromContent = Effect.fnUntraced(function* (content: ResponseRecord) {
  const contentType = yield* Option.match(stringProperty({ name: "type", record: content }), {
    onNone: () => diagnosticEchoError("Diagnostic echo current-turn content requires type."),
    onSome: Effect.succeed,
  });
  return yield* Match.value(contentType).pipe(
    Match.when("input_text", () => echoSummaryFromTextContent(content)),
    Match.when("input_image", () => echoSummaryFromImageContent(content)),
    Match.when("input_file", () => echoSummaryFromFileContent(content)),
    Match.orElse(() =>
      diagnosticEchoError(`Unsupported diagnostic echo current-turn content: ${contentType}.`),
    ),
  );
});

/** Builds the deterministic final answer text for the diagnostic/echo scenario. */
export const diagnosticEchoAnswerText = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  const messages = yield* Schema.decodeUnknownEffect(responseInputSchema)(turn.prompt.input).pipe(
    Effect.mapError(() =>
      diagnosticEchoError("Diagnostic echo requires normalized current-turn user input."),
    ),
  );
  const message = yield* singleCurrentUserMessage(messages);
  const summaries = yield* Effect.forEach(message.content, echoSummaryFromContent);
  const nonEmptySummaries = yield* Option.match(
    Option.fromUndefinedOr([summaries].filter((values) => values.length > 0).at(0)),
    {
      onNone: () =>
        diagnosticEchoError(
          "Diagnostic echo requires at least one supported current-turn content block.",
        ),
      onSome: Effect.succeed,
    },
  );
  const encodedSummaries = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
    nonEmptySummaries,
  ).pipe(
    Effect.mapError(() => diagnosticEchoError("Diagnostic echo could not encode input summary.")),
  );
  return `Diagnostic echo current user input: ${encodedSummaries}`;
});

/** Builds the diagnostic/echo runtime stream after input summary validation succeeds. */
export const diagnosticEchoRuntimeEventStream = ({
  answerText,
}: {
  readonly answerText: string;
}): Stream.Stream<AgentRuntimeEvent, AgentDriverError> =>
  Stream.fromIterable([
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.echoMessageItemId,
      text: answerText,
      chunkCount: 1,
    }),
    createRuntimeTurnSucceededEvent(),
  ]);

/** Builds the diagnostic/echo turn result with driver-owned validation and session effects. */
export const diagnosticEchoTurnResult = Effect.fnUntraced(function* ({
  turn,
  validateOptions,
  externalSession,
  cancellation,
}: {
  readonly turn: AgentDriverTurn;
  readonly validateOptions: EffectContract<void, AgentDriverError>;
  readonly externalSession: EffectContract<ExternalSessionState, AgentDriverError>;
  readonly cancellation: AgentCancellationOutcome;
}) {
  yield* validateOptions;
  const answerText = yield* diagnosticEchoAnswerText(turn);
  const nextExternalSession = yield* externalSession;
  return {
    runtimeEvents: diagnosticEchoRuntimeEventStream({ answerText }),
    externalSession: nextExternalSession,
    cancel: Effect.succeed(cancellation),
  } satisfies AgentDriverTurnResult;
});
