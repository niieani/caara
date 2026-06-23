import { Effect, Schema } from "effect";

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

/** Extracts the current Codex turn input into the `agy --prompt` string. */
export const extractAntigravityCliPrompt = Effect.fnUntraced(function* ({ input }: AgentTurnInput) {
  const messages = yield* Schema.decodeUnknownEffect(ResponsesPromptInput)(input).pipe(
    Effect.mapError(
      () =>
        new AgentDriverError({
          message: "Antigravity driver only supports current-turn user input_text messages.",
        }),
    ),
  );
  return messages.flatMap((message) => message.content.map((part) => part.text)).join("\n");
});
