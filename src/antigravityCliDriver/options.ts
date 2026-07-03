import { Effect, Match, Option, Schema } from "effect";
import type * as Path from "effect/Path";

import type { CaaraSettingsValue } from "../caaraSettings.ts";
import {
  createInvalidPromptAgentDriverError,
  type AgentDriverError,
} from "../mockResponsesProvider/agentDriver.ts";
import type {
  CodexAdvisoryEffort,
  CodexSandboxPosture,
} from "../mockResponsesProvider/codexTurnContext.ts";

/** Parsed Antigravity reasoning relay mode. */
export type AntigravityRelayMode = "on" | "off";

/** Driver-owned Antigravity CLI options parsed from provider query params. */
export interface AntigravityCliOptions {
  readonly model: string;
  readonly effort: CodexAdvisoryEffort | undefined;
  readonly printTimeoutSeconds: number;
  readonly sandbox: boolean;
  readonly dangerouslySkipPermissions: boolean;
  readonly addDirs: readonly string[];
  readonly logFile: string | undefined;
  readonly reasoning: AntigravityRelayMode;
  readonly activity: AntigravityRelayMode;
}

/** Supported raw Antigravity driver option names. */
const antigravityOptionNames = [
  "model",
  "print_timeout_seconds",
  "sandbox",
  "dangerously_skip_permissions",
  "add_dirs",
  "log_file",
  "reasoning",
  "activity",
  "effort",
] as const;

/** Antigravity effort values accepted from provider query params and Codex advisory input. */
const antigravityEfforts = ["low", "medium", "high", "xhigh"] as const;

/** Default effort used when a known Antigravity model family is selected without advisory effort. */
const defaultAntigravityEffort = "medium" as const satisfies CodexAdvisoryEffort;

/** Default Antigravity print-mode wait timeout that Caara passes to `agy`. */
const defaultPrintTimeoutSeconds = 7200;

/** Maximum Antigravity print-mode wait timeout accepted as driver passthrough. */
const maxPrintTimeoutSeconds = 86400;

/** Builds an explicit Antigravity driver option validation failure. */
const optionError = (message: string): AgentDriverError =>
  createInvalidPromptAgentDriverError({ message });

/** JSON encoded `add_dirs` option schema. */
const AddDirsOption = Schema.fromJsonString(Schema.Array(Schema.NonEmptyString));

/** Validated non-empty Antigravity model option. */
const ModelOption = Schema.NonEmptyString;

/** Schema for Antigravity effort values accepted at the driver boundary. */
const EffortOption = Schema.Literals(antigravityEfforts);

/** Returns the first unsupported Antigravity raw option name, if present. */
const unsupportedAntigravityOption = (
  rawDriverOptions: Readonly<Record<string, string>>,
): string | undefined =>
  Object.keys(rawDriverOptions).find(
    (optionName) => !antigravityOptionNames.some((knownName) => knownName === optionName),
  );

/** Fails when an unsupported Antigravity driver option is present. */
const validateSupportedOptions = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  return yield* Option.match(
    Option.fromUndefinedOr(unsupportedAntigravityOption(rawDriverOptions)),
    {
      onNone: () => Effect.void,
      onSome: (optionName) =>
        Effect.fail(optionError(`Unsupported Antigravity driver option: ${optionName}.`)),
    },
  );
});

/** Parses one optional Antigravity boolean option. */
const parseBooleanOption = Effect.fnUntraced(function* ({
  rawDriverOptions,
  optionName,
  defaultValue,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly optionName: string;
  readonly defaultValue: boolean;
}) {
  return yield* Option.match(Option.fromUndefinedOr(rawDriverOptions[optionName]), {
    onNone: () => Effect.succeed(defaultValue),
    onSome: (value) =>
      Match.value(value).pipe(
        Match.when("true", () => Effect.succeed(true)),
        Match.when("false", () => Effect.succeed(false)),
        Match.orElse(() => Effect.fail(optionError(`${optionName} must be true or false.`))),
      ),
  });
});

/** Parses the Antigravity model from query options or the requested model suffix. */
const parseModelOption = Effect.fnUntraced(function* ({
  externalModelSpecifier,
  rawDriverOptions,
}: {
  readonly externalModelSpecifier: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
}) {
  return yield* Schema.decodeUnknownEffect(ModelOption)(
    rawDriverOptions.model ?? externalModelSpecifier,
  ).pipe(Effect.mapError(() => optionError("model must be non-empty.")));
});

/** Parses the optional Antigravity effort driver option. */
const parseEffortOption = Effect.fnUntraced(function* (value: string | undefined) {
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, (): CodexAdvisoryEffort | undefined => undefined),
    onSome: (effort) =>
      Schema.decodeUnknownEffect(EffortOption)(effort).pipe(
        Effect.mapError(() => optionError(`Unsupported Antigravity effort: ${effort}.`)),
      ),
  });
});

/** Chooses the Antigravity effort source, with query option precedence over Codex advisory effort. */
const effectiveAntigravityEffort = ({
  driverEffort,
  advisoryEffort,
}: {
  readonly driverEffort: CodexAdvisoryEffort | undefined;
  readonly advisoryEffort: CodexAdvisoryEffort | undefined;
}): CodexAdvisoryEffort => driverEffort ?? advisoryEffort ?? defaultAntigravityEffort;

/** Maps Gemini 3.5 Flash effort to the closest supported Antigravity display model. */
const geminiFlashDisplayModel = (effort: CodexAdvisoryEffort): string =>
  Match.value(effort).pipe(
    Match.when("low", () => "Gemini 3.5 Flash (Low)"),
    Match.when("medium", () => "Gemini 3.5 Flash (Medium)"),
    Match.when("high", () => "Gemini 3.5 Flash (High)"),
    Match.when("xhigh", () => "Gemini 3.5 Flash (High)"),
    Match.exhaustive,
  );

/** Maps Gemini 3.1 Pro effort to the closest supported Antigravity display model. */
const geminiProDisplayModel = (effort: CodexAdvisoryEffort): string =>
  Match.value(effort).pipe(
    Match.when("low", () => "Gemini 3.1 Pro (Low)"),
    Match.when("medium", () => "Gemini 3.1 Pro (High)"),
    Match.when("high", () => "Gemini 3.1 Pro (High)"),
    Match.when("xhigh", () => "Gemini 3.1 Pro (High)"),
    Match.exhaustive,
  );

/** Maps known Antigravity model-family slugs to exact display model names. */
const antigravityDisplayModelFromSpecifier = ({
  model,
  effort,
}: {
  readonly model: string;
  readonly effort: CodexAdvisoryEffort;
}): string =>
  Match.value(model).pipe(
    Match.when("gemini-3.5-flash", () => geminiFlashDisplayModel(effort)),
    Match.when("gemini-3.1-pro", () => geminiProDisplayModel(effort)),
    Match.when("claude-sonnet-4.6", () => "Claude Sonnet 4.6 (Thinking)"),
    Match.when("claude-opus-4.6", () => "Claude Opus 4.6 (Thinking)"),
    Match.when("gpt-oss-120b", () => "GPT-OSS 120B (Medium)"),
    Match.orElse((unknownModel) => unknownModel),
  );

/** Maps Codex sandbox posture into Antigravity's default sandbox behavior. */
const sandboxDefaultFromCodexPosture = (sandboxPosture: CodexSandboxPosture | undefined): boolean =>
  Option.match(Option.fromUndefinedOr(sandboxPosture), {
    onNone: () => false,
    onSome: (posture) =>
      Match.value(posture).pipe(
        Match.when("none", () => false),
        Match.when("enforced", () => true),
        Match.exhaustive,
      ),
  });

/** Parses one optional bounded integer Antigravity option. */
const parseBoundedIntegerValue = ({
  optionName,
  value,
  min,
  max,
}: {
  readonly optionName: string;
  readonly value: string;
  readonly min: number;
  readonly max: number;
}) => {
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  return Match.value(valid).pipe(
    Match.when(true, () => Effect.succeed(parsed)),
    Match.orElse(() =>
      Effect.fail(optionError(`${optionName} must be an integer from ${min} to ${max}.`)),
    ),
  );
};

/** Parses one optional bounded integer Antigravity option. */
const parseBoundedIntegerOption = Effect.fnUntraced(function* ({
  rawDriverOptions,
  optionName,
  min,
  max,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly optionName: string;
  readonly min: number;
  readonly max: number;
}) {
  return yield* Option.match(Option.fromUndefinedOr(rawDriverOptions[optionName]), {
    onNone: () => Effect.map(Effect.void, (): number | undefined => undefined),
    onSome: (value) => parseBoundedIntegerValue({ optionName, value, min, max }),
  });
});

/** Parses one optional relay mode option. */
const parseRelayModeOption = Effect.fnUntraced(function* ({
  rawDriverOptions,
  optionName,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly optionName: string;
}) {
  return yield* Option.match(Option.fromUndefinedOr(rawDriverOptions[optionName]), {
    onNone: () => Effect.succeed("on" as const),
    onSome: (value) =>
      Match.value(value).pipe(
        Match.when("on", () => Effect.succeed("on" as const)),
        Match.when("off", () => Effect.succeed("off" as const)),
        Match.orElse(() => Effect.fail(optionError(`${optionName} must be on or off.`))),
      ),
  });
});

/** Validates one absolute filesystem path option. */
const validateAbsolutePath = Effect.fnUntraced(function* ({
  pathService,
  optionName,
  value,
}: {
  readonly pathService: Path.Path;
  readonly optionName: string;
  readonly value: string;
}) {
  return yield* Match.value(pathService.isAbsolute(value)).pipe(
    Match.when(true, () => Effect.succeed(value)),
    Match.orElse(() => Effect.fail(optionError(`${optionName} must be an absolute path.`))),
  );
});

/** Parses the optional JSON encoded Antigravity add_dirs option. */
const parseAddDirsOption = Effect.fnUntraced(function* ({
  rawDriverOptions,
  pathService,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly pathService: Path.Path;
}) {
  const encoded = rawDriverOptions.add_dirs;
  const addDirs = yield* Option.match(Option.fromUndefinedOr(encoded), {
    onNone: () => Effect.succeed([] as readonly string[]),
    onSome: (value) =>
      Schema.decodeUnknownEffect(AddDirsOption)(value).pipe(
        Effect.mapError(() =>
          optionError("add_dirs must be a JSON array of non-empty absolute paths."),
        ),
      ),
  });
  return yield* Effect.forEach(addDirs, (value) =>
    validateAbsolutePath({ pathService, optionName: "add_dirs", value }),
  );
});

/** Parses an optional absolute Antigravity log-file override. */
const parseLogFileOption = Effect.fnUntraced(function* ({
  rawDriverOptions,
  pathService,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly pathService: Path.Path;
}) {
  return yield* Option.match(Option.fromUndefinedOr(rawDriverOptions.log_file), {
    onNone: () => Effect.map(Effect.void, (): string | undefined => undefined),
    onSome: (value) => validateAbsolutePath({ pathService, optionName: "log_file", value }),
  });
});

/** Fails unless dangerous permission skipping is enabled by Caara server settings. */
const validateDangerousSkipPermissions = Effect.fnUntraced(function* ({
  caaraSettings,
  dangerouslySkipPermissions,
}: {
  readonly caaraSettings: CaaraSettingsValue;
  readonly dangerouslySkipPermissions: boolean;
}) {
  const allowed = !dangerouslySkipPermissions || caaraSettings.allowDangerousSkipPermissions;
  return yield* Option.match(Option.fromUndefinedOr([allowed].filter(Boolean).at(0)), {
    onNone: () =>
      Effect.fail(
        optionError(
          "Antigravity --dangerously-skip-permissions requires --allow-dangerous-skip-permissions.",
        ),
      ),
    onSome: () => Effect.void,
  });
});

/** Parses and validates Antigravity driver options from raw provider query params. */
export const parseAntigravityCliOptions = Effect.fnUntraced(function* ({
  caaraSettings,
  externalModelSpecifier,
  rawDriverOptions,
  advisoryEffort,
  sandboxPosture,
  pathService,
}: {
  readonly caaraSettings: CaaraSettingsValue;
  readonly externalModelSpecifier: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly advisoryEffort?: CodexAdvisoryEffort;
  readonly sandboxPosture?: CodexSandboxPosture;
  readonly pathService: Path.Path;
}) {
  yield* validateSupportedOptions(rawDriverOptions);
  const rawModel = yield* parseModelOption({ externalModelSpecifier, rawDriverOptions });
  const effort = yield* parseEffortOption(rawDriverOptions.effort);
  const model = antigravityDisplayModelFromSpecifier({
    model: rawModel,
    effort: effectiveAntigravityEffort({ driverEffort: effort, advisoryEffort }),
  });
  const sandbox = yield* parseBooleanOption({
    rawDriverOptions,
    optionName: "sandbox",
    defaultValue: sandboxDefaultFromCodexPosture(sandboxPosture),
  });
  const dangerouslySkipPermissions = yield* parseBooleanOption({
    rawDriverOptions,
    optionName: "dangerously_skip_permissions",
    defaultValue: false,
  });
  yield* validateDangerousSkipPermissions({ caaraSettings, dangerouslySkipPermissions });
  const printTimeoutSeconds = yield* parseBoundedIntegerOption({
    rawDriverOptions,
    optionName: "print_timeout_seconds",
    min: 1,
    max: maxPrintTimeoutSeconds,
  });
  const addDirs = yield* parseAddDirsOption({ rawDriverOptions, pathService });
  const logFile = yield* parseLogFileOption({ rawDriverOptions, pathService });
  const reasoning = yield* parseRelayModeOption({ rawDriverOptions, optionName: "reasoning" });
  const activity = yield* parseRelayModeOption({ rawDriverOptions, optionName: "activity" });

  return {
    model,
    effort,
    printTimeoutSeconds: printTimeoutSeconds ?? defaultPrintTimeoutSeconds,
    sandbox,
    dangerouslySkipPermissions,
    addDirs,
    logFile,
    reasoning,
    activity,
  } satisfies AntigravityCliOptions;
});

/** Builds repeatable Antigravity `--add-dir` argv entries. */
const addDirArgv = (addDirs: readonly string[]): readonly string[] =>
  addDirs.flatMap((directory) => ["--add-dir", directory]);

/** Builds the Antigravity CLI argv from validated driver options. */
export const buildAntigravityCliArgv = ({
  prompt,
  options,
  logFilePath,
  conversationId,
}: {
  readonly prompt: string;
  readonly options: AntigravityCliOptions;
  readonly logFilePath: string;
  readonly conversationId?: string;
}): readonly string[] => [
  "--prompt",
  prompt,
  ...Option.match(Option.fromUndefinedOr(conversationId), {
    onNone: () => [],
    onSome: (id) => ["--conversation", id],
  }),
  "--model",
  options.model,
  "--print-timeout",
  `${options.printTimeoutSeconds}s`,
  ...Match.value(options.sandbox).pipe(
    Match.when(true, () => ["--sandbox"]),
    Match.orElse(() => []),
  ),
  ...Match.value(options.dangerouslySkipPermissions).pipe(
    Match.when(true, () => ["--dangerously-skip-permissions"]),
    Match.orElse(() => []),
  ),
  ...addDirArgv(options.addDirs),
  "--log-file",
  options.logFile ?? logFilePath,
];
