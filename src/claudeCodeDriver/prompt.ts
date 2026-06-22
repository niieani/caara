import { Effect, Option, Schema } from "effect";

import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";

/** Responses content block carrying user text into an external code-agent prompt. */
const responseInputTextContentSchema = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String,
});

/** Responses message item shape accepted by the Claude Code prompt extractor. */
const responseInputMessageSchema = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.String,
  content: Schema.Array(responseInputTextContentSchema),
});

/** Responses input shape accepted by the Claude Code prompt extractor. */
const responseInputSchema = Schema.Array(responseInputMessageSchema);

/** Builds an explicit prompt extraction failure. */
const promptError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Extracts the textual Claude Code prompt from a decoded Responses input value. */
export const extractClaudeCodePrompt = Effect.fnUntraced(function* (input: Schema.Json) {
  const messages = yield* Schema.decodeUnknownEffect(responseInputSchema)(input).pipe(
    Effect.mapError(() =>
      promptError("Claude Code driver requires Responses input message content with input_text."),
    ),
  );
  const prompt = messages
    .flatMap((message) => message.content.map((content) => content.text))
    .join("\n\n");

  return yield* Option.match(
    Option.fromUndefinedOr([prompt].filter((candidate) => candidate.length > 0).at(0)),
    {
      onNone: () => promptError("Claude Code driver requires at least one input_text block."),
      onSome: Effect.succeed,
    },
  );
});
