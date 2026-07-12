import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Console, Effect, Match, Option, Schema } from "effect";

import type {
  AgentDriverExecutableRequirement,
  AgentDriverExecutableRequirementsRegistry,
} from "./agentDriverRequirements.ts";
import { caaraAgentDriverExecutableRequirementsRegistry } from "./caaraDriverRequirements.ts";
import {
  caaraBuiltInServicePathEntries,
  pathEntriesFromValue,
  type CaaraExecutionPathEnvironment,
} from "./caaraExecutionPath.ts";
import { liveCaaraPortableDoctorProbe, runPortableDoctorCheck } from "./caaraPortableDoctor.ts";
import {
  type CaaraConfigLoader,
  type CaaraServiceConfigValue,
  type CaaraSettingsResolution,
  resolveCaaraSettingsResolutionFromArgs,
} from "./caaraSettings.ts";
import { caaraHealthProbeUrl } from "./caaraStatus.ts";

/** Registry value consumed by the doctor command. */
export type CaaraDoctorRequirementsRegistry = AgentDriverExecutableRequirementsRegistry["Service"];

/** One executable check produced by the doctor command. */
export interface CaaraDoctorExecutableCheck {
  readonly driverName: string;
  readonly externalAgentKind: string;
  readonly executableName: string;
  readonly searchedPaths: readonly string[];
  readonly foundPath: string | undefined;
  readonly fixHint: string | undefined;
}

/** In-process doctor command result. */
export interface CaaraDoctorResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
  readonly checks: readonly CaaraDoctorExecutableCheck[];
  readonly appendedPathEntries: readonly string[];
  readonly configUpdated: boolean;
  readonly configPath: string;
}

/** Options accepted by the in-process doctor command seam. */
export interface RunCaaraDoctorOptions {
  readonly args: readonly string[];
  readonly configLoader?: CaaraConfigLoader;
  readonly env?: CaaraExecutionPathEnvironment;
  readonly requirementsRegistry?: CaaraDoctorRequirementsRegistry;
}

/** Options accepted by the live doctor CLI wrapper. */
export interface RunCaaraDoctorCliOptions {
  readonly args: readonly string[];
}

/** Failure while running the doctor command. */
export class CaaraDoctorError extends Schema.TaggedErrorClass<CaaraDoctorError>()(
  "CaaraDoctorError",
  {
    message: Schema.String,
  },
) {}

/** Parsed doctor-specific CLI options plus args forwarded to settings parsing. */
interface CaaraDoctorCliOptions {
  readonly fix: boolean;
  readonly settingsArgs: readonly string[];
}

/** Builds one typed doctor failure. */
const caaraDoctorError = (message: string): CaaraDoctorError => new CaaraDoctorError({ message });

/** Parses `caara doctor` options before forwarding shared settings flags. */
const parseDoctorCliOptions = ({
  args,
}: {
  readonly args: readonly string[];
}): CaaraDoctorCliOptions => ({
  fix: args.includes("--fix"),
  settingsArgs: args.filter((arg) => arg !== "--fix"),
});

/** Returns a de-duplicated list while preserving first-seen order. */
const uniqueEntries = (entries: readonly string[]): readonly string[] => [...new Set(entries)];

/** Checks whether one candidate path is executable by the current user. */
const isExecutableFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise({
    try: () =>
      fs
        .access(filePath, fsConstants.X_OK)
        .then(() => true)
        .catch(() => false),
    catch: () => false,
  });
});

/** Finds the first executable matching one requirement in the provided search path. */
const findExecutable = Effect.fnUntraced(function* ({
  executableName,
  pathEntries,
}: {
  readonly executableName: string;
  readonly pathEntries: readonly string[];
}) {
  let foundPath: string | undefined;
  for (const entry of pathEntries) {
    const candidatePath = path.join(entry, executableName);
    const executable = yield* isExecutableFile({ filePath: candidatePath });
    foundPath ??= [candidatePath].filter(() => executable).at(0);
  }
  return foundPath;
});

/** Builds the service-mode executable search path for doctor checks. */
const servicePathEntries = Effect.fnUntraced(function* ({
  resolution,
  env,
}: {
  readonly resolution: CaaraSettingsResolution;
  readonly env: CaaraExecutionPathEnvironment;
}) {
  const builtInEntries = yield* caaraBuiltInServicePathEntries({ env });
  return uniqueEntries([...resolution.settings.path, ...builtInEntries]);
});

/** Human-facing remediation hint for one missing executable. */
const missingExecutableFixHint = ({
  executableName,
}: {
  readonly executableName: string;
}): string => `Install ${executableName}, then run caara doctor --fix.`;

/** Checks one executable requirement against the effective service path. */
const checkRequirement = Effect.fnUntraced(function* ({
  requirement,
  pathEntries,
}: {
  readonly requirement: AgentDriverExecutableRequirement;
  readonly pathEntries: readonly string[];
}) {
  const foundPath = yield* findExecutable({
    executableName: requirement.executableName,
    pathEntries,
  });
  const fixHint = Option.match(Option.fromUndefinedOr(foundPath), {
    onNone: () => missingExecutableFixHint({ executableName: requirement.executableName }),
    onSome: () => undefined,
  });
  return {
    driverName: requirement.driverName,
    externalAgentKind: requirement.externalAgentKind,
    executableName: requirement.executableName,
    searchedPaths: pathEntries,
    foundPath,
    fixHint,
  } satisfies CaaraDoctorExecutableCheck;
});

/** Checks every registered executable requirement against one service path. */
const checkRequirements = Effect.fnUntraced(function* ({
  requirements,
  pathEntries,
}: {
  readonly requirements: readonly AgentDriverExecutableRequirement[];
  readonly pathEntries: readonly string[];
}) {
  return yield* Effect.forEach(
    requirements,
    (requirement) => checkRequirement({ requirement, pathEntries }),
    {
      concurrency: 1,
    },
  );
});

/** Returns the process exit code for final doctor checks. */
const doctorExitCode = (checks: readonly CaaraDoctorExecutableCheck[]): 0 | 1 =>
  Match.value(foundChecks(checks).length > 0).pipe(
    Match.when(true, () => 0 as const),
    Match.orElse(() => 1 as const),
  );

/** Builds the final non-empty doctor result after checks have run. */
const nonEmptyDoctorResult = ({
  checks,
  appendedPathEntries,
  configPath,
}: {
  readonly checks: readonly CaaraDoctorExecutableCheck[];
  readonly appendedPathEntries: readonly string[];
  readonly configPath: string;
}): CaaraDoctorResult => ({
  exitCode: doctorExitCode(checks),
  message: formatDoctorMessage({ checks, appendedPathEntries, configPath }),
  checks,
  appendedPathEntries,
  configUpdated: appendedPathEntries.length > 0,
  configPath,
});

/** Runs executable checks and optional repair for a non-empty requirements registry. */
const runNonEmptyDoctor = Effect.fnUntraced(function* ({
  requirements,
  resolution,
  env,
  fix,
}: {
  readonly requirements: readonly AgentDriverExecutableRequirement[];
  readonly resolution: CaaraSettingsResolution;
  readonly env: CaaraExecutionPathEnvironment;
  readonly fix: boolean;
}) {
  const initialPathEntries = yield* servicePathEntries({ resolution, env });
  const initialChecks = yield* checkRequirements({
    requirements,
    pathEntries: initialPathEntries,
  });
  const appendedPathEntries = yield* Match.value(
    fix && missingChecks(initialChecks).length > 0,
  ).pipe(
    Match.when(true, () => repairConfigPathEntries({ checks: initialChecks, resolution, env })),
    Match.orElse(() => Effect.succeed([] as readonly string[])),
  );
  const finalResolution = repairedResolution({ resolution, appendedPathEntries });
  const finalPathEntries = yield* servicePathEntries({ resolution: finalResolution, env });
  const finalChecks = yield* checkRequirements({
    requirements,
    pathEntries: finalPathEntries,
  });

  return nonEmptyDoctorResult({
    checks: finalChecks,
    appendedPathEntries,
    configPath: resolution.configPath,
  });
});

/** Returns checks that did not find an executable. */
const missingChecks = (
  checks: readonly CaaraDoctorExecutableCheck[],
): readonly CaaraDoctorExecutableCheck[] => checks.filter((check) => check.foundPath === undefined);

/** Returns checks that found a real external driver executable. */
const foundChecks = (
  checks: readonly CaaraDoctorExecutableCheck[],
): readonly CaaraDoctorExecutableCheck[] => checks.filter((check) => check.foundPath !== undefined);

/** Searches repair paths for one missing executable and returns a config path entry to append. */
const repairPathEntryForMissingCheck = Effect.fnUntraced(function* ({
  check,
  repairPathEntries,
  builtInEntries,
  existingConfigEntries,
}: {
  readonly check: CaaraDoctorExecutableCheck;
  readonly repairPathEntries: readonly string[];
  readonly builtInEntries: readonly string[];
  readonly existingConfigEntries: readonly string[];
}) {
  const foundPath = yield* findExecutable({
    executableName: check.executableName,
    pathEntries: repairPathEntries,
  });
  return Option.getOrUndefined(
    Option.fromUndefinedOr(foundPath).pipe(
      Option.map(path.dirname),
      Option.filter((directory) => !builtInEntries.includes(directory)),
      Option.filter((directory) => !existingConfigEntries.includes(directory)),
    ),
  );
});

/** Writes one strict Caara YAML config document. */
const writeCaaraConfig = Effect.fnUntraced(function* ({
  configPath,
  config,
}: {
  readonly configPath: string;
  readonly config: CaaraServiceConfigValue;
}) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(configPath), { recursive: true }),
    catch: (cause) => caaraDoctorError(`Failed to create Caara config directory: ${String(cause)}`),
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(configPath, `${Bun.YAML.stringify(config)}\n`, "utf8"),
    catch: (cause) => caaraDoctorError(`Failed to write Caara config: ${String(cause)}`),
  });
});

/** Appends newly discovered non-default executable directories to the YAML config. */
const repairConfigPathEntries = Effect.fnUntraced(function* ({
  checks,
  resolution,
  env,
}: {
  readonly checks: readonly CaaraDoctorExecutableCheck[];
  readonly resolution: CaaraSettingsResolution;
  readonly env: CaaraExecutionPathEnvironment;
}) {
  const builtInEntries = yield* caaraBuiltInServicePathEntries({ env });
  const existingConfigEntries = resolution.config.path ?? [];
  const repairPathEntries = uniqueEntries([...pathEntriesFromValue(env.PATH), ...builtInEntries]);
  const discoveredEntries = yield* Effect.forEach(
    missingChecks(checks),
    (check) =>
      repairPathEntryForMissingCheck({
        check,
        repairPathEntries,
        builtInEntries,
        existingConfigEntries,
      }),
    { concurrency: 1 },
  );
  const appendedPathEntries = uniqueEntries(
    discoveredEntries.filter((entry): entry is string => entry !== undefined),
  );
  const updatedPathEntries = [...existingConfigEntries, ...appendedPathEntries];

  yield* Option.match(Option.fromUndefinedOr(appendedPathEntries.at(0)), {
    onNone: () => Effect.void,
    onSome: () =>
      writeCaaraConfig({
        configPath: resolution.configPath,
        config: {
          ...resolution.config,
          path: updatedPathEntries,
        },
      }),
  });

  return appendedPathEntries;
});

/** Rebuilds settings resolution with appended config path entries applied in memory. */
const repairedResolution = ({
  resolution,
  appendedPathEntries,
}: {
  readonly resolution: CaaraSettingsResolution;
  readonly appendedPathEntries: readonly string[];
}): CaaraSettingsResolution => ({
  ...resolution,
  settings: {
    ...resolution.settings,
    path: [...resolution.settings.path, ...appendedPathEntries],
  },
  config: {
    ...resolution.config,
    path: [...(resolution.config.path ?? []), ...appendedPathEntries],
  },
});

/** Formats one successful executable check line. */
const formatFoundCheck = (check: CaaraDoctorExecutableCheck): string =>
  `ok ${check.driverName} (${check.externalAgentKind}) requires ${check.executableName}: ${check.foundPath}`;

/** Formats the missing-driver diagnostic prefix. */
const formatMissingDriverPrefix = (optional: boolean): string =>
  Match.value(optional).pipe(
    Match.when(true, () => "warning optional driver missing"),
    Match.orElse(() => "missing"),
  );

/** Formats one missing executable check line. */
const formatMissingCheck = ({
  check,
  optional,
}: {
  readonly check: CaaraDoctorExecutableCheck;
  readonly optional: boolean;
}): string =>
  [
    `${formatMissingDriverPrefix(optional)} ${check.driverName} (${check.externalAgentKind}) requires ${check.executableName}`,
    `searched: ${check.searchedPaths.join(path.delimiter)}`,
    `hint: ${check.fixHint ?? missingExecutableFixHint({ executableName: check.executableName })}`,
  ].join("; ");

/** Formats one executable check for CLI/result output. */
const formatCheck = ({
  check,
  optionalMissing,
}: {
  readonly check: CaaraDoctorExecutableCheck;
  readonly optionalMissing: boolean;
}): string =>
  Match.value(check.foundPath).pipe(
    Match.when(undefined, () => formatMissingCheck({ check, optional: optionalMissing })),
    Match.orElse(() => formatFoundCheck(check)),
  );

/** Formats the full doctor result message. */
const formatDoctorMessage = ({
  checks,
  appendedPathEntries,
  configPath,
}: {
  readonly checks: readonly CaaraDoctorExecutableCheck[];
  readonly appendedPathEntries: readonly string[];
  readonly configPath: string;
}): string => {
  const hasFoundRealDriver = foundChecks(checks).length > 0;
  const header = Match.value({
    hasFoundRealDriver,
    missingCount: missingChecks(checks).length,
  }).pipe(
    Match.when({ missingCount: 0 }, () => "Caara doctor ok"),
    Match.when({ hasFoundRealDriver: true }, () => "Caara doctor ok with optional driver warnings"),
    Match.orElse(() => "Caara doctor found no real external driver executables"),
  );
  const repairLine = Option.match(Option.fromUndefinedOr(appendedPathEntries.at(0)), {
    onNone: () => undefined,
    onSome: () => `updated ${configPath} path entries: ${appendedPathEntries.join(path.delimiter)}`,
  });
  return [
    header,
    repairLine,
    ...checks.map((check) =>
      formatCheck({
        check,
        optionalMissing: hasFoundRealDriver && check.foundPath === undefined,
      }),
    ),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

/** Builds a fatal doctor result when no real external driver executable requirements exist. */
const emptyDoctorResult = ({ configPath }: { readonly configPath: string }): CaaraDoctorResult => ({
  exitCode: 1,
  message:
    "Caara doctor found no real external driver executables\nno registered real driver executable requirements",
  checks: [],
  appendedPathEntries: [],
  configUpdated: false,
  configPath,
});

/** Runs `caara doctor` without terminating the host process. */
export const runCaaraDoctor = Effect.fnUntraced(function* ({
  args,
  configLoader,
  env = process.env,
  requirementsRegistry = caaraAgentDriverExecutableRequirementsRegistry,
}: RunCaaraDoctorOptions) {
  const options = parseDoctorCliOptions({ args });
  const resolution = yield* resolveCaaraSettingsResolutionFromArgs({
    args: options.settingsArgs,
    configLoader,
    env,
  });
  return yield* Match.value(requirementsRegistry.requirements.length).pipe(
    Match.when(0, () => Effect.succeed(emptyDoctorResult({ configPath: resolution.configPath }))),
    Match.orElse(() =>
      runNonEmptyDoctor({
        requirements: requirementsRegistry.requirements,
        resolution,
        env,
        fix: options.fix,
      }),
    ),
  );
});

/** Runs the live `caara doctor` CLI command and fails for nonzero doctor status. */
export const runCaaraDoctorCli = Effect.fnUntraced(function* ({ args }: RunCaaraDoctorCliOptions) {
  const result = yield* runCaaraDoctor({ args });
  const options = parseDoctorCliOptions({ args });
  const settings = yield* resolveCaaraSettingsResolutionFromArgs({ args: options.settingsArgs });
  const portable = yield* runPortableDoctorCheck({
    cwd: process.cwd(),
    origin: caaraHealthProbeUrl({ settings: settings.settings }).replace(/\/health$/u, ""),
    probe: liveCaaraPortableDoctorProbe,
  });
  const combinedExitCode = Match.value(result.exitCode === 0 && portable.exitCode === 0).pipe(
    Match.when(true, () => 0 as const),
    Match.orElse(() => 1 as const),
  );
  const message = [result.message, portable.message].join("\n");
  yield* Console.log(message);

  return yield* Option.match(
    Option.fromUndefinedOr([message].filter(() => combinedExitCode !== 0).at(0)),
    {
      onNone: () => Effect.void,
      onSome: (failureMessage) => Effect.fail(caaraDoctorError(failureMessage)),
    },
  );
});
