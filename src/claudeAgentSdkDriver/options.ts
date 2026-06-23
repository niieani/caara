import type { EffortLevel, Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Match, Option, Schema } from "effect";

import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";

/** Effort values accepted by the installed Claude Agent SDK. */
const claudeAgentSdkEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/** Validated Claude Agent SDK options derived from provider query parameters. */
export interface ClaudeAgentSdkDriverOptions {
  readonly effort: EffortLevel | undefined;
  readonly maxBudgetUsd: number | undefined;
  readonly tools: ClaudeQueryOptions["tools"] | undefined;
  readonly includePartialMessages: boolean | undefined;
}

/** Query startup state used to choose between new-session and resume options. */
export type ClaudeAgentSdkSessionStartup =
  | {
      readonly _tag: "Start";
      readonly sessionId: string;
    }
  | {
      readonly _tag: "Resume";
      readonly resume: string;
    };

/** Option names accepted by the Claude Agent SDK driver. */
const supportedClaudeAgentSdkOptionNames = new Set([
  "effort",
  "max_budget_usd",
  "tools",
  "include_partial_messages",
]);

/** Schema for effort values supported by the installed Claude Agent SDK. */
const effortSchema = Schema.Literals(claudeAgentSdkEfforts);

/** Builds an explicit Claude SDK driver option validation failure. */
const optionError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Validates the optional Claude effort query parameter. */
const parseEffortOption = Effect.fnUntraced(function* (value: string | undefined) {
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, () => undefined),
    onSome: (effort) =>
      Schema.decodeUnknownEffect(effortSchema)(effort).pipe(
        Effect.mapError(() => optionError(`Unsupported Claude Agent SDK effort: ${effort}.`)),
      ),
  });
});

/** Validates the optional Claude maximum-budget query parameter. */
const parseMaxBudgetUsdOption = Effect.fnUntraced(function* (value: string | undefined) {
  const validValue = Option.fromUndefinedOr(value).pipe(
    Option.map(Number),
    Option.filter(Number.isFinite),
    Option.filter((candidate) => candidate > 0),
  );
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, () => undefined),
    onSome: () =>
      Option.match(validValue, {
        onNone: () => optionError("Claude Agent SDK max_budget_usd must be a positive number."),
        onSome: Effect.succeed,
      }),
  });
});

/** Parses the optional Claude SDK tool-selection query parameter. */
const parseToolsOption = (value: string | undefined): ClaudeQueryOptions["tools"] | undefined =>
  Option.match(Option.fromUndefinedOr(value), {
    onNone: () => undefined,
    onSome: (tools) =>
      Match.value(tools).pipe(
        Match.when("disabled", () => []),
        Match.when("default", () => ({ type: "preset", preset: "claude_code" }) as const),
        Match.orElse((customTools) =>
          customTools
            .split(",")
            .map((tool) => tool.trim())
            .filter((tool) => tool.length > 0),
        ),
      ),
  });

/** Validates a string boolean query parameter used for SDK driver flags. */
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
        Match.orElse(() => optionError(`Claude Agent SDK ${name} must be true or false.`)),
      ),
  });
});

/** Builds the optional SDK effort options object. */
const effortQueryOptions = (
  effort: EffortLevel | undefined,
): Readonly<Partial<Pick<ClaudeQueryOptions, "effort">>> =>
  Option.match(Option.fromUndefinedOr(effort), {
    onNone: () => ({}),
    onSome: (nextEffort) => ({ effort: nextEffort }),
  });

/** Builds the optional SDK budget options object. */
const maxBudgetUsdQueryOptions = (
  maxBudgetUsd: number | undefined,
): Readonly<Partial<Pick<ClaudeQueryOptions, "maxBudgetUsd">>> =>
  Option.match(Option.fromUndefinedOr(maxBudgetUsd), {
    onNone: () => ({}),
    onSome: (nextMaxBudgetUsd) => ({ maxBudgetUsd: nextMaxBudgetUsd }),
  });

/** Builds the optional SDK tool-selection options object. */
const toolsQueryOptions = (
  tools: ClaudeQueryOptions["tools"] | undefined,
): Readonly<Partial<Pick<ClaudeQueryOptions, "tools">>> =>
  Option.match(Option.fromUndefinedOr(tools), {
    onNone: () => ({}),
    onSome: (nextTools) => ({ tools: nextTools }),
  });

/** Validates raw provider query params into SDK driver-owned options. */
export const parseClaudeAgentSdkDriverOptions = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  const unknownOption = Object.keys(rawDriverOptions).find(
    (optionName) => !supportedClaudeAgentSdkOptionNames.has(optionName),
  );
  yield* Option.match(Option.fromUndefinedOr(unknownOption), {
    onNone: () => Effect.void,
    onSome: (optionName) =>
      optionError(`Unsupported Claude Agent SDK driver option: ${optionName}.`),
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
    includePartialMessages,
  } satisfies ClaudeAgentSdkDriverOptions;
});

/** Builds official Claude Agent SDK query options for one turn. */
export const buildClaudeAgentSdkQueryOptions = Effect.fnUntraced(function* ({
  cwd,
  model,
  rawDriverOptions,
  startup,
}: {
  readonly cwd: string;
  readonly model: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly startup: ClaudeAgentSdkSessionStartup;
}) {
  const driverOptions = yield* parseClaudeAgentSdkDriverOptions(rawDriverOptions);
  const sessionOptions = Match.valueTags(startup, {
    Start: ({ sessionId }) => ({ sessionId }),
    Resume: ({ resume }) => ({ resume }),
  });

  return {
    cwd,
    model,
    ...sessionOptions,
    includePartialMessages: driverOptions.includePartialMessages ?? true,
    ...effortQueryOptions(driverOptions.effort),
    ...maxBudgetUsdQueryOptions(driverOptions.maxBudgetUsd),
    ...toolsQueryOptions(driverOptions.tools),
  } satisfies ClaudeQueryOptions;
});
