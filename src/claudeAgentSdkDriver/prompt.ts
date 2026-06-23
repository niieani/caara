import { Effect, Option, Schema } from "effect";

import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";

/** Responses content block carrying text through Codex history. */
const responseTextContentSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
});

/** Responses message item shape accepted by the Claude Agent SDK prompt extractor. */
const responseInputMessageSchema = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.String,
  content: Schema.Array(responseTextContentSchema),
});

/** Responses input shape accepted by the Claude Agent SDK prompt extractor. */
const responseInputSchema = Schema.Array(responseInputMessageSchema);

/** Builds an explicit prompt extraction failure. */
const promptError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Extracts the latest user text prompt for the SDK query bridge. */
export const extractClaudeAgentSdkPrompt = Effect.fnUntraced(function* (input: Schema.Json) {
  const messages = yield* Schema.decodeUnknownEffect(responseInputSchema)(input).pipe(
    Effect.mapError(() =>
      promptError("Claude Agent SDK driver requires Responses input message history."),
    ),
  );
  const latestUserMessage = messages.filter((message) => message.role === "user").at(-1);
  const prompt = (latestUserMessage?.content ?? [])
    .filter((content) => content.type === "input_text")
    .map((content) => content.text ?? "")
    .join("\n\n");

  return yield* Option.match(
    Option.fromUndefinedOr([prompt].filter((candidate) => candidate.length > 0).at(0)),
    {
      onNone: () => promptError("Claude Agent SDK driver requires at least one input_text block."),
      onSome: Effect.succeed,
    },
  );
});
