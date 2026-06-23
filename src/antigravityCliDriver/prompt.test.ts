import { assert, describe, it } from "@effect/vitest";
import { Effect, type Schema } from "effect";

import { extractAntigravityCliPrompt } from "./prompt.ts";

/** Builds one normalized current-turn user message for Antigravity prompt tests. */
const currentUserMessage = (content: readonly Schema.Json[]): Schema.Json => ({
  type: "message",
  role: "user",
  content,
});

/** Raw mixed Codex input fixture that should be normalized before driver dispatch. */
const rawCodexEnvelope = (): Schema.Json => [
  {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "developer instructions" }],
  },
  {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "# AGENTS.md instructions\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
      },
      {
        type: "input_text",
        text: "<environment_context><cwd>/workspace</cwd></environment_context>",
      },
    ],
  },
  currentUserMessage([{ type: "input_text", text: "actual user task" }]),
];

describe("Antigravity CLI prompt extraction", () => {
  it.effect("extracts text from normalized current-turn user input", () =>
    Effect.gen(function* () {
      const prompt = yield* extractAntigravityCliPrompt({
        input: [
          currentUserMessage([
            { type: "input_text", text: "first line" },
            { type: "input_text", text: "second line" },
          ]),
        ],
      });

      assert.strictEqual(prompt, "first line\nsecond line");
    }),
  );

  it.effect("fails unsupported normalized current-turn content explicitly", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        extractAntigravityCliPrompt({
          input: [currentUserMessage([{ type: "input_image", image_url: "file://image.png" }])],
        }),
      );

      assert.match(error.message, /only supports current-turn user input_text messages/i);
    }),
  );

  it.effect("fails raw mixed Codex input instead of filtering it inside the driver", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        extractAntigravityCliPrompt({
          input: rawCodexEnvelope(),
        }),
      );

      assert.match(error.message, /only supports current-turn user input_text messages/i);
    }),
  );
});
