import { Effect, Match, Option, Schema } from "effect";

import { AgentDriverError, type AgentTurnInput } from "../mockResponsesProvider/agentDriver.ts";

/** Responses input text part supported by the Antigravity prompt extractor. */
const ResponsesInputTextPart = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String,
});

/** Current-turn user message shape accepted by the Antigravity CLI prompt extractor. */
const ResponsesUserMessage = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("user"),
  content: Schema.Array(ResponsesInputTextPart),
});

/** Current-turn Responses input shape supported for the Antigravity CLI prompt. */
const ResponsesPromptInput = Schema.Array(ResponsesUserMessage);

/** Builds an explicit Antigravity prompt extraction failure. */
const promptError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Returns the single normalized user message expected at the driver boundary. */
const singleCurrentUserMessage = Effect.fnUntraced(function* (
  messages: readonly (typeof ResponsesUserMessage.Type)[],
) {
  const message = yield* Option.match(Option.fromUndefinedOr(messages.at(0)), {
    onNone: () => promptError("Antigravity driver requires a current user message."),
    onSome: Effect.succeed,
  });
  yield* Match.value(messages.length).pipe(
    Match.when(1, () => Effect.void),
    Match.orElse(() =>
      Effect.fail(promptError("Antigravity driver requires exactly one normalized user message.")),
    ),
  );
  return message;
});

/** Extracts the current Codex turn input into the `agy --prompt` string. */
export const extractAntigravityCliPrompt = Effect.fnUntraced(function* ({ input }: AgentTurnInput) {
  const messages = yield* Schema.decodeUnknownEffect(ResponsesPromptInput)(input).pipe(
    Effect.mapError(() =>
      promptError("Antigravity driver only supports current-turn user input_text messages."),
    ),
  );
  const message = yield* singleCurrentUserMessage(messages);
  return message.content.map((part) => part.text).join("\n");
});
