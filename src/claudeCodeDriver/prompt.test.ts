import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { extractClaudeCodePrompt } from "./prompt.ts";

describe("Claude Code prompt extraction", () => {
  it.effect("extracts the latest user input from Codex follow-up history", () =>
    Effect.gen(function* () {
      const prompt = yield* extractClaudeCodePrompt([
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "developer instructions" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first request" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "first response" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "follow-up request" }],
        },
      ]);

      assert.strictEqual(prompt, "follow-up request");
    }),
  );
});
