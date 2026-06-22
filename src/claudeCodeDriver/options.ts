import { Effect, Match, Option, Schema } from "effect";

import {
  claudeCodeEfforts,
  type ClaudeCodeEffort,
  type ClaudeCodeToolSelection,
} from "../claudeCodeContract/invocation.ts";
import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";

/** Validated Claude Code driver options derived from provider query parameters. */
export interface ClaudeCodeDriverOptions {
  readonly effort: ClaudeCodeEffort | undefined;
  readonly maxBudgetUsd: string | undefined;
  readonly tools: ClaudeCodeToolSelection | undefined;
  readonly debugFile: string | undefined;
  readonly includePartialMessages: boolean | undefined;
}

/** Option names accepted by the Claude Code driver. */
const supportedClaudeDriverOptionNames = new Set([
  "effort",
  "max_budget_usd",
  "tools",
  "debug_file",
  "include_partial_messages",
]);

/** Schema for Claude Code effort values proven against the installed CLI. */
const claudeCodeEffortSchema = Schema.Literals(claudeCodeEfforts);

/** Builds an explicit Claude driver option validation failure. */
const optionError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Validates the optional Claude Code effort query parameter. */
const parseEffortOption = Effect.fnUntraced(function* (value: string | undefined) {
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, () => undefined),
    onSome: (effort) =>
      Schema.decodeUnknownEffect(claudeCodeEffortSchema)(effort).pipe(
        Effect.mapError(() => optionError(`Unsupported Claude Code effort: ${effort}.`)),
      ),
  });
});

/** Validates the optional Claude Code maximum-budget query parameter. */
const parseMaxBudgetUsdOption = Effect.fnUntraced(function* (value: string | undefined) {
  const validValue = Option.fromUndefinedOr(value).pipe(
    Option.filter((candidate) => Number.isFinite(Number(candidate))),
    Option.filter((candidate) => Number(candidate) > 0),
  );
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, () => undefined),
    onSome: () =>
      Option.match(validValue, {
        onNone: () => optionError("Claude Code max_budget_usd must be a positive number."),
        onSome: Effect.succeed,
      }),
  });
});

/** Parses the optional Claude Code tool-selection query parameter. */
const parseToolsOption = (value: string | undefined): ClaudeCodeToolSelection | undefined =>
  Option.match(Option.fromUndefinedOr(value), {
    onNone: () => undefined,
    onSome: (tools) =>
      Match.value(tools).pipe(
        Match.when("disabled", () => "disabled" as const),
        Match.when("default", () => "default" as const),
        Match.orElse((customTools) =>
          customTools
            .split(",")
            .map((tool) => tool.trim())
            .filter((tool) => tool.length > 0),
        ),
      ),
  });

/** Validates a string boolean query parameter used for driver flags. */
const parseBooleanOption = Effect.fnUntraced(function* ({
  name,
  value,
}: {
  readonly name: string;
  readonly value: string | undefined;
}) {
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, () => undefined),
    onSome: (rawValue) =>
      Match.value(rawValue).pipe(
        Match.when("true", () => Effect.succeed(true)),
        Match.when("false", () => Effect.succeed(false)),
        Match.orElse(() => optionError(`Claude Code ${name} must be true or false.`)),
      ),
  });
});

/** Validates raw provider query params into Claude Code driver-owned options. */
export const parseClaudeCodeDriverOptions = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  const unknownOption = Object.keys(rawDriverOptions).find(
    (optionName) => !supportedClaudeDriverOptionNames.has(optionName),
  );
  yield* Option.match(Option.fromUndefinedOr(unknownOption), {
    onNone: () => Effect.void,
    onSome: (optionName) => optionError(`Unsupported Claude Code driver option: ${optionName}.`),
  });

  const effort = yield* parseEffortOption(rawDriverOptions.effort);
  const maxBudgetUsd = yield* parseMaxBudgetUsdOption(rawDriverOptions.max_budget_usd);
  const includePartialMessages = yield* parseBooleanOption({
    name: "include_partial_messages",
    value: rawDriverOptions.include_partial_messages,
  });

  return {
    effort,
    maxBudgetUsd,
    tools: parseToolsOption(rawDriverOptions.tools),
    debugFile: rawDriverOptions.debug_file,
    includePartialMessages,
  } satisfies ClaudeCodeDriverOptions;
});
