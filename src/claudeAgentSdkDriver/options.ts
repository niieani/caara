import type {
  CanUseTool,
  EffortLevel,
  OnUserDialog,
  Options as ClaudeQueryOptions,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Match, Option, Schema } from "effect";

import {
  claudeAskUserQuestionToolName,
  claudeNonInteractivePermissionDeniedMessage,
  claudeNonInteractivePermissionMode,
  includesReservedInteractiveTool,
  parseClaudeToolList,
  withReservedInteractiveToolDisallowed,
} from "../claudeInteractionPolicy.ts";
import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";
import type { CodexAdvisoryEffort } from "../mockResponsesProvider/codexTurnContext.ts";

/** Effort values accepted by the installed Claude Agent SDK. */
const claudeAgentSdkEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/** Permission modes Caara allows because they do not require interactive prompting. */
const claudeAgentSdkNonInteractivePermissionModes = [
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const satisfies readonly PermissionMode[];

/** Claude SDK permission mode subset safe for noninteractive Codex turns. */
type ClaudeAgentSdkNonInteractivePermissionMode =
  (typeof claudeAgentSdkNonInteractivePermissionModes)[number];

/** Returns the canonical provider query option name for Claude SDK permission mode. */
const permissionModeOptionName = (): "permission_mode" => "permission_mode";

/** Validated Claude Agent SDK options derived from provider query parameters. */
export interface ClaudeAgentSdkDriverOptions {
  readonly effort: EffortLevel | undefined;
  readonly maxBudgetUsd: number | undefined;
  readonly tools: ClaudeQueryOptions["tools"] | undefined;
  readonly allowedTools: readonly string[] | undefined;
  readonly disallowedTools: readonly string[] | undefined;
  readonly includePartialMessages: boolean | undefined;
  readonly permissionMode: ClaudeAgentSdkNonInteractivePermissionMode;
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
  "allowed_tools",
  "disallowed_tools",
  "include_partial_messages",
  permissionModeOptionName(),
  "activity",
]);

/** Schema for effort values supported by the installed Claude Agent SDK. */
const effortSchema = Schema.Literals(claudeAgentSdkEfforts);

/** Schema for Claude SDK permission modes that do not require interactive prompting. */
const permissionModeSchema = Schema.Literals(claudeAgentSdkNonInteractivePermissionModes);

/** Builds an explicit Claude SDK driver option validation failure. */
const optionError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Builds the explicit reserved interactive-tool validation failure. */
const reservedInteractiveToolError = (optionName: string): AgentDriverError =>
  optionError(
    `Claude Agent SDK ${optionName} cannot allow ${claudeAskUserQuestionToolName()}; it is reserved for unsupported interactive questions.`,
  );

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
const parseToolsOption = Effect.fnUntraced(function* (value: string | undefined) {
  const parsedTools = Option.match(Option.fromUndefinedOr(value), {
    onNone: () => undefined,
    onSome: (tools) =>
      Match.value(tools).pipe(
        Match.when("disabled", () => []),
        Match.when("default", () => ({ type: "preset", preset: "claude_code" }) as const),
        Match.orElse(parseClaudeToolList),
      ),
  });
  const reservedTool = Option.fromUndefinedOr(
    [parsedTools]
      .filter(
        (tools): tools is string[] =>
          Array.isArray(tools) && includesReservedInteractiveTool(tools),
      )
      .at(0),
  );
  yield* Option.match(reservedTool, {
    onNone: () => Effect.void,
    onSome: () => reservedInteractiveToolError("tools"),
  });
  return parsedTools;
});

/** Parses an optional comma-delimited Claude tool list query parameter. */
const parseToolListOption = Effect.fnUntraced(function* ({
  name,
  value,
  rejectReservedTool,
}: {
  readonly name: string;
  readonly value: string | undefined;
  readonly rejectReservedTool: boolean;
}) {
  const tools = Option.match(Option.fromUndefinedOr(value), {
    onNone: () => undefined,
    onSome: parseClaudeToolList,
  });
  const invalidReservedTool = Option.fromUndefinedOr(
    [tools]
      .filter(
        (parsedTools): parsedTools is string[] =>
          parsedTools !== undefined &&
          rejectReservedTool &&
          includesReservedInteractiveTool(parsedTools),
      )
      .at(0),
  );
  yield* Option.match(invalidReservedTool, {
    onNone: () => Effect.void,
    onSome: () => reservedInteractiveToolError(name),
  });
  return tools;
});

/** Denies SDK permission prompts because Caara has no interactive approval path. */
const denyPermissionRequest: CanUseTool = (_toolName, _input, { toolUseID }) =>
  Promise.resolve({
    behavior: "deny",
    message: claudeNonInteractivePermissionDeniedMessage(),
    toolUseID,
    decisionClassification: "user_reject",
  });

/** Cancels unsupported SDK user dialogs explicitly instead of leaving them parked. */
const cancelUserDialog: OnUserDialog = () => Promise.resolve({ behavior: "cancelled" });

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

/** Validates the optional Claude permission mode query parameter. */
const parsePermissionModeOption = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  return yield* Option.match(Option.fromUndefinedOr(rawDriverOptions[permissionModeOptionName()]), {
    onNone: () => Effect.succeed(claudeNonInteractivePermissionMode()),
    onSome: (permissionMode) =>
      Schema.decodeUnknownEffect(permissionModeSchema)(permissionMode).pipe(
        Effect.mapError(() =>
          optionError(
            `Claude Agent SDK ${permissionModeOptionName()} must be one of ${claudeAgentSdkNonInteractivePermissionModes.join(", ")}.`,
          ),
        ),
      ),
  });
});

/** Parses the optional Claude SDK activity commentary visibility option. */
export const parseClaudeAgentSdkActivityTransportVisibility = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  return yield* Match.value(rawDriverOptions.activity ?? "on").pipe(
    Match.when("on", () => Effect.succeed("visible" as const)),
    Match.when("off", () => Effect.succeed("relay_only" as const)),
    Match.orElse((value) =>
      optionError(`Claude Agent SDK activity must be on or off, received ${value}.`),
    ),
  );
});

/** Builds the optional SDK effort options object. */
const effortQueryOptions = (
  effort: EffortLevel | undefined,
): Readonly<Partial<Pick<ClaudeQueryOptions, "effort">>> =>
  Option.match(Option.fromUndefinedOr(effort), {
    onNone: () => ({}),
    onSome: (nextEffort) => ({ effort: nextEffort }),
  });

/** Maps Codex advisory effort into the Claude SDK effort scale without adding Claude-only values. */
const claudeEffortFromCodexAdvisory = (
  advisoryEffort: CodexAdvisoryEffort | undefined,
): EffortLevel | undefined =>
  Option.match(Option.fromUndefinedOr(advisoryEffort), {
    onNone: () => undefined,
    onSome: (effort) =>
      Match.value(effort).pipe(
        Match.when("low", () => "low" as const),
        Match.when("medium", () => "medium" as const),
        Match.when("high", () => "high" as const),
        Match.when("xhigh", () => "xhigh" as const),
        Match.exhaustive,
      ),
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

/** Builds the optional SDK allowed-tools options object. */
const allowedToolsQueryOptions = (
  allowedTools: readonly string[] | undefined,
): Readonly<Partial<Pick<ClaudeQueryOptions, "allowedTools">>> =>
  Option.match(Option.fromUndefinedOr(allowedTools), {
    onNone: () => ({}),
    onSome: (nextAllowedTools) => ({ allowedTools: [...nextAllowedTools] }),
  });

/** Builds the required SDK disallowed-tools options object with AskUserQuestion reserved. */
const disallowedToolsQueryOptions = (
  disallowedTools: readonly string[] | undefined,
): Pick<ClaudeQueryOptions, "disallowedTools"> => ({
  disallowedTools: [...withReservedInteractiveToolDisallowed(disallowedTools)],
});

/** Builds the SDK opt-in required when bypassing Claude permission checks. */
const dangerousPermissionBypassQueryOptions = (
  permissionMode: ClaudeAgentSdkNonInteractivePermissionMode,
): Readonly<Partial<Pick<ClaudeQueryOptions, "allowDangerouslySkipPermissions">>> =>
  Match.value(permissionMode).pipe(
    Match.when("bypassPermissions", () => ({ allowDangerouslySkipPermissions: true })),
    Match.orElse(() => ({})),
  );

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
  const tools = yield* parseToolsOption(rawDriverOptions.tools);
  const allowedTools = yield* parseToolListOption({
    name: "allowed_tools",
    value: rawDriverOptions.allowed_tools,
    rejectReservedTool: true,
  });
  const disallowedTools = yield* parseToolListOption({
    name: "disallowed_tools",
    value: rawDriverOptions.disallowed_tools,
    rejectReservedTool: false,
  });
  const permissionMode = yield* parsePermissionModeOption(rawDriverOptions);

  return {
    effort,
    maxBudgetUsd,
    tools,
    allowedTools,
    disallowedTools,
    includePartialMessages,
    permissionMode,
  } satisfies ClaudeAgentSdkDriverOptions;
});

/** Builds official Claude Agent SDK query options for one turn. */
export const buildClaudeAgentSdkQueryOptions = Effect.fnUntraced(function* ({
  advisoryEffort,
  cwd,
  model,
  rawDriverOptions,
  startup,
}: {
  readonly advisoryEffort?: CodexAdvisoryEffort;
  readonly cwd: string;
  readonly model: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly startup: ClaudeAgentSdkSessionStartup;
}) {
  const driverOptions = yield* parseClaudeAgentSdkDriverOptions(rawDriverOptions);
  const effort = driverOptions.effort ?? claudeEffortFromCodexAdvisory(advisoryEffort);
  const sessionOptions = Match.valueTags(startup, {
    Start: ({ sessionId }) => ({ sessionId }),
    Resume: ({ resume }) => ({ resume }),
  });

  return {
    cwd,
    model,
    ...sessionOptions,
    includePartialMessages: driverOptions.includePartialMessages ?? true,
    ...effortQueryOptions(effort),
    ...maxBudgetUsdQueryOptions(driverOptions.maxBudgetUsd),
    ...toolsQueryOptions(driverOptions.tools),
    ...allowedToolsQueryOptions(driverOptions.allowedTools),
    ...disallowedToolsQueryOptions(driverOptions.disallowedTools),
    permissionMode: driverOptions.permissionMode,
    ...dangerousPermissionBypassQueryOptions(driverOptions.permissionMode),
    canUseTool: denyPermissionRequest,
    onUserDialog: cancelUserDialog,
    supportedDialogKinds: [],
  } satisfies ClaudeQueryOptions;
});
