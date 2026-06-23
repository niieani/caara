import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { parseClaudeCodeDriverOptions } from "./options.ts";

/** Extracts the driver error from an expected Claude Code option failure result. */
const driverErrorMessage = (result: Result.Result<unknown, { readonly message: string }>): string =>
  Result.match(result, {
    onFailure: (error) => error.message,
    onSuccess: () => assert.fail("expected Claude Code option validation failure"),
  });

describe("Claude Code permission policy", () => {
  it.effect("defaults to non-interactive permission mode and disallows AskUserQuestion", () =>
    Effect.gen(function* () {
      const options = yield* parseClaudeCodeDriverOptions({});

      assert.strictEqual(options.permissionMode, "dontAsk");
      assert.deepStrictEqual(options.disallowedTools, ["AskUserQuestion"]);
    }),
  );

  it.effect("rejects option attempts that would allow AskUserQuestion", () =>
    Effect.gen(function* () {
      const allowedToolsResult = yield* Effect.result(
        parseClaudeCodeDriverOptions({ allowed_tools: "AskUserQuestion" }),
      );
      const toolsResult = yield* Effect.result(
        parseClaudeCodeDriverOptions({ tools: "Read,AskUserQuestion" }),
      );

      assert.match(driverErrorMessage(allowedToolsResult), /AskUserQuestion.*reserved/i);
      assert.match(driverErrorMessage(toolsResult), /AskUserQuestion.*reserved/i);
    }),
  );
});
