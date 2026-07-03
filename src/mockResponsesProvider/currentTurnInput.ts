import { Effect, Option, Schema } from "effect";

import {
  createInvalidPromptAgentDriverError,
  type AgentDriverError,
  type AgentTurnInput,
} from "./agentDriver.ts";

/** Responses input item represented as a decoded JSON object. */
type ResponseRecord = Readonly<Record<string, Schema.Json>>;

/** Generic Responses object schema used before current-turn-specific validation. */
const responseRecordSchema = Schema.Record(Schema.String, Schema.Json);

/** Responses message item shape accepted by the core current-turn normalizer. */
const responseInputMessageSchema = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.String,
  content: Schema.Array(responseRecordSchema),
});

/** Responses input shape accepted by the core current-turn normalizer. */
const responseInputSchema = Schema.Array(responseRecordSchema);

/** Codex setup markers that external agents read through their own native workspace context. */
const codexPreludeTextMarkers = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<INSTRUCTIONS>",
] as const;

/** Builds an explicit current-turn normalization failure. */
const currentTurnInputError = (message: string): AgentDriverError =>
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

/** Returns the text value from one decoded content record when it is textual. */
const textContentValue = (content: ResponseRecord): readonly string[] =>
  Option.match(stringProperty({ name: "text", record: content }), {
    onNone: () => [],
    onSome: (text) => [text],
  });

/** Returns all text values from one decoded Responses message. */
const messageTextValues = (message: typeof responseInputMessageSchema.Type): readonly string[] =>
  message.content.flatMap(textContentValue);

/** Returns whether one user message is Codex setup context rather than the delegated task. */
const isCodexPreludeUserMessage = (message: typeof responseInputMessageSchema.Type): boolean =>
  messageTextValues(message).some((text) =>
    codexPreludeTextMarkers.some((marker) => text.includes(marker)),
  );

/** Finds the latest user message while ignoring non-user and non-message history items. */
const latestUserMessage = (items: readonly ResponseRecord[]) =>
  items
    .flatMap((item) =>
      Option.match(Schema.decodeUnknownOption(responseInputMessageSchema)(item), {
        onNone: () => [],
        onSome: (message) => [message],
      }),
    )
    .filter((message) => message.role === "user")
    .at(-1);

/** Fails when the latest user-like message is Codex setup context instead of a task. */
const validateCurrentUserMessage = Effect.fnUntraced(function* (
  message: typeof responseInputMessageSchema.Type,
) {
  return yield* Option.match(
    Option.fromUndefinedOr([message].filter(isCodexPreludeUserMessage).at(0)),
    {
      onNone: () => Effect.succeed(message),
      onSome: () =>
        currentTurnInputError("Caara requires a current user request after Codex setup context."),
    },
  );
});

/** Normalizes mixed Codex Responses input into the driver-facing current user turn. */
export const normalizeCurrentTurnInput = Effect.fnUntraced(function* ({ input }: AgentTurnInput) {
  const items = yield* Schema.decodeUnknownEffect(responseInputSchema)(input).pipe(
    Effect.mapError(() => currentTurnInputError("Caara requires Responses input message history.")),
  );
  const message = yield* Option.match(Option.fromUndefinedOr(latestUserMessage(items)), {
    onNone: () => currentTurnInputError("Caara requires a current user request."),
    onSome: validateCurrentUserMessage,
  });
  return { input: [message] } satisfies AgentTurnInput;
});
