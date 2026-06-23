import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";

import { normalizeCurrentTurnInput } from "./currentTurnInput.ts";

/** Unknown error shape with a displayable message field. */
const errorMessageSchema = Schema.Struct({
  message: Schema.String,
});

/** Developer message fixture matching the shape Codex Desktop sends before user context. */
const developerMessage = {
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "Use the local Caara driver." }],
} as const;

/** Codex AGENTS/environment prelude fixture observed in real subagent requests. */
const codexPreludeMessage = {
  type: "message",
  role: "user",
  content: [
    {
      type: "input_text",
      text: "# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>\nUse Bun.\n</INSTRUCTIONS>",
    },
    {
      type: "input_text",
      text: "<environment_context>\n  <cwd>/workspace/project</cwd>\n</environment_context>",
    },
  ],
} as const;

/** Current managing-agent request fixture that should reach external drivers. */
const actualUserMessage = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Read README.md line 5." }],
} as const;

/** Extracts a displayable message from an unknown normalization failure. */
const normalizationFailureText = (error: unknown): string =>
  Option.match(Schema.decodeUnknownOption(errorMessageSchema)(error), {
    onNone: () => String(error),
    onSome: (decoded) => decoded.message,
  });

/** Extracts an error message from an expected normalization failure. */
const failureMessage = (result: Result.Result<unknown, unknown>): string =>
  Result.match(result, {
    onFailure: normalizationFailureText,
    onSuccess: () => assert.fail("expected current-turn normalization failure"),
  });

describe("current turn input normalization", () => {
  it.effect("selects the actual user request from real Codex Desktop prelude shape", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeCurrentTurnInput({
        input: [developerMessage, codexPreludeMessage, actualUserMessage],
      });

      assert.deepStrictEqual(normalized.input, [actualUserMessage]);
    }),
  );

  it.effect("fails instead of treating Codex prelude as the delegated task", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        normalizeCurrentTurnInput({
          input: [developerMessage, codexPreludeMessage],
        }),
      );

      assert.match(failureMessage(result), /current user request/i);
    }),
  );

  it.effect("fails when the latest user-like message is prelude context", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        normalizeCurrentTurnInput({
          input: [actualUserMessage, codexPreludeMessage],
        }),
      );

      assert.match(failureMessage(result), /current user request/i);
    }),
  );
});
