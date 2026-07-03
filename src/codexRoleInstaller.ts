import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Console, Effect, Match, Option } from "effect";

import { pathEntriesFromValue } from "./caaraExecutionPath.ts";
import {
  resolveCaaraSettingsResolutionFromArgs,
  type CaaraConfigLoader,
  type CaaraSettingsValue,
} from "./caaraSettings.ts";
import {
  safeCodexRoleDriverCatalogs,
  type CaaraCodexRoleDefinition,
  type CaaraCodexRoleDriverCatalog,
} from "./codexRoleCatalog.ts";
import { caaraCodexRoleInstallerError } from "./codexRoleInstallerError.ts";
import {
  parseInstallCodexRolesOptions,
  yoloValidationFailure,
} from "./codexRoleInstallerOptions.ts";
import {
  firstCollision,
  preflightRoleWrites,
  removeMarkedRoles,
  removeStaleMarkedRoles,
  type RoleCollisionPlan,
  type RoleWritePlan,
  writePlansFromPreflight,
  writeRoleFile,
} from "./codexRoleManagedFiles.ts";

export { CaaraCodexRoleInstallerError } from "./codexRoleInstallerError.ts";

/** Environment fields consumed by standalone Codex role installation. */
export interface CaaraCodexRoleInstallerEnvironment extends Readonly<
  Record<string, string | undefined>
> {
  readonly CODEX_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly PATH?: string | undefined;
}

/** One skipped installed-role driver report. */
export interface CaaraCodexRoleSkippedDriver {
  readonly driverName: string;
  readonly executableName: string;
  readonly reason: string;
}

/** In-process result returned by Codex role installation. */
export interface CaaraCodexRoleInstallResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
  readonly skippedDrivers: readonly CaaraCodexRoleSkippedDriver[];
  readonly targetDirectory: string;
  readonly writtenFiles: readonly string[];
}

/** Options accepted by in-process Codex role installation. */
export interface RunCaaraInstallCodexRolesOptions {
  readonly args: readonly string[];
  readonly configLoader?: CaaraConfigLoader;
  readonly env?: CaaraCodexRoleInstallerEnvironment;
}

/** Options accepted by the live Codex role installation CLI wrapper. */
export interface RunCaaraInstallCodexRolesCliOptions {
  readonly args: readonly string[];
}

/** Options accepted by in-process Codex role cleanup. */
export interface RunCaaraUninstallCodexRolesOptions {
  readonly args: readonly string[];
  readonly env?: CaaraCodexRoleInstallerEnvironment;
}

/** Options accepted by the live Codex role cleanup CLI wrapper. */
export interface RunCaaraUninstallCodexRolesCliOptions {
  readonly args: readonly string[];
}

/** Successful driver availability detection result. */
interface AvailableRoleDriver {
  readonly _tag: "Available";
  readonly catalog: CaaraCodexRoleDriverCatalog;
  readonly executablePath: string;
}

/** Skipped driver availability detection result. */
interface SkippedRoleDriver {
  readonly _tag: "Skipped";
  readonly driverName: string;
  readonly executableName: string;
  readonly reason: string;
}

/** Driver availability detection result. */
type DetectedRoleDriver = AvailableRoleDriver | SkippedRoleDriver;

/** In-process result returned by Codex role cleanup. */
export interface CaaraCodexRoleUninstallResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
  readonly removedFiles: readonly string[];
  readonly targetDirectory: string;
}

/** Reads role installer environment fields from the host process. */
const processCodexRoleInstallerEnvironment = (): CaaraCodexRoleInstallerEnvironment => ({
  CODEX_HOME: process.env.CODEX_HOME,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
});

/** Maps bind-all service hosts to loopback targets usable by local Codex clients. */
const codexRoleProviderHost = ({ host }: { readonly host: string }): string =>
  Match.value(host).pipe(
    Match.when("0.0.0.0", () => "127.0.0.1"),
    Match.when("::", () => "::1"),
    Match.orElse((providerHost) => providerHost),
  );

/** Formats a host for an HTTP URL, including IPv6 bracket handling. */
const hostForUrl = (host: string): string =>
  [host]
    .filter((candidate) => candidate.includes(":"))
    .map((candidate) => `[${candidate}]`)
    .at(0) ?? host;

/** Builds the Caara Responses base URL rendered into generated Codex roles. */
const codexRoleBaseUrlFromSettings = ({
  settings,
}: {
  readonly settings: CaaraSettingsValue;
}): string => {
  const host = codexRoleProviderHost({ host: settings.host });
  return `http://${hostForUrl(host)}:${settings.port}/v1`;
};

/** Returns true when an environment path value can be used. */
const hasNonEmptyPath = (value: string): boolean => value.length > 0;

/** Resolves the default Codex agents directory from CODEX_HOME or HOME. */
export const defaultCodexAgentsDirectory = ({
  env,
}: {
  readonly env: CaaraCodexRoleInstallerEnvironment;
}): string | undefined =>
  Option.match(Option.fromUndefinedOr(env.CODEX_HOME).pipe(Option.filter(hasNonEmptyPath)), {
    onNone: () =>
      Option.match(Option.fromUndefinedOr(env.HOME).pipe(Option.filter(hasNonEmptyPath)), {
        onNone: () => undefined,
        onSome: (home) => path.join(home, ".codex", "agents"),
      }),
    onSome: (codexHome) => path.join(codexHome, "agents"),
  });

/** Resolves the target directory selected by install-codex-roles args. */
const targetDirectoryFromArgs = ({
  args,
  env,
}: {
  readonly args: readonly string[];
  readonly env: CaaraCodexRoleInstallerEnvironment;
}): string | undefined =>
  Match.value(args.length).pipe(
    Match.when(0, () => defaultCodexAgentsDirectory({ env })),
    Match.when(1, () => args.at(0)),
    Match.orElse(() => undefined),
  );

/** Checks whether one candidate path is executable. */
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

/** Finds the first executable with the given name in the invoking shell PATH. */
const findShellExecutable = Effect.fnUntraced(function* ({
  executableName,
  env,
}: {
  readonly executableName: string;
  readonly env: CaaraCodexRoleInstallerEnvironment;
}) {
  const candidates = pathEntriesFromValue(env.PATH).map((entry) =>
    path.join(entry, executableName),
  );
  const availability = yield* Effect.forEach(
    candidates,
    (candidate) =>
      isExecutableFile({ filePath: candidate }).pipe(
        Effect.map((executable) => [candidate].filter(() => executable).at(0)),
      ),
    { concurrency: 1 },
  );
  return availability.find((candidate) => candidate !== undefined);
});

/** Detects whether one role driver catalog is available from the invoking shell PATH. */
const detectRoleDriver = Effect.fnUntraced(function* ({
  catalog,
  env,
}: {
  readonly catalog: CaaraCodexRoleDriverCatalog;
  readonly env: CaaraCodexRoleInstallerEnvironment;
}) {
  const executablePath = yield* findShellExecutable({
    env,
    executableName: catalog.executableName,
  });
  return Option.match(Option.fromUndefinedOr(executablePath), {
    onNone: () =>
      ({
        _tag: "Skipped",
        driverName: catalog.driverName,
        executableName: catalog.executableName,
        reason: "command not found on PATH",
      }) satisfies DetectedRoleDriver,
    onSome: (foundPath) =>
      ({
        _tag: "Available",
        catalog,
        executablePath: foundPath,
      }) satisfies DetectedRoleDriver,
  });
});

/** Detects available role catalogs and skipped drivers from the invoking shell PATH. */
const detectRoleDrivers = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraCodexRoleInstallerEnvironment;
}) {
  return yield* Effect.forEach(
    safeCodexRoleDriverCatalogs,
    (catalog) => detectRoleDriver({ catalog, env }),
    { concurrency: 1 },
  );
});

/** Flattens available role catalogs to generated role definitions. */
const rolesFromAvailableDrivers = (detected: readonly DetectedRoleDriver[]) =>
  detected
    .filter((driver): driver is AvailableRoleDriver => driver._tag === "Available")
    .flatMap((driver) => driver.catalog.roles);

/** Builds skipped-driver reports from detection results. */
const skippedDriversFromDetected = (
  detected: readonly DetectedRoleDriver[],
): readonly CaaraCodexRoleSkippedDriver[] =>
  detected
    .filter((driver): driver is SkippedRoleDriver => driver._tag === "Skipped")
    .map(({ driverName, executableName, reason }) => ({
      driverName,
      executableName,
      reason,
    }));

/** Formats the role installer result message. */
const formatInstallResultMessage = ({
  skippedDrivers,
  targetDirectory,
  writtenFiles,
}: {
  readonly skippedDrivers: readonly CaaraCodexRoleSkippedDriver[];
  readonly targetDirectory: string;
  readonly writtenFiles: readonly string[];
}): string =>
  [
    `installed ${writtenFiles.length} Codex roles to ${targetDirectory}`,
    ...skippedDrivers.map(
      (driver) => `skipped ${driver.driverName}: ${driver.executableName} ${driver.reason}`,
    ),
  ].join("\n");

/** Builds an invalid install-codex-roles result without writing files. */
const invalidInstallResult = ({
  message,
}: {
  readonly message: string;
}): CaaraCodexRoleInstallResult => ({
  exitCode: 1,
  message,
  skippedDrivers: [],
  targetDirectory: "",
  writtenFiles: [],
});

/** Builds an invalid uninstall-codex-roles result without removing files. */
const invalidUninstallResult = ({
  message,
}: {
  readonly message: string;
}): CaaraCodexRoleUninstallResult => ({
  exitCode: 1,
  message,
  removedFiles: [],
  targetDirectory: "",
});

/** Builds the successful install result after preflight passes. */
const successfulInstallResult = Effect.fnUntraced(function* ({
  baseUrl,
  detected,
  roles,
  targetDirectory,
  writePlans,
  yolo,
}: {
  readonly baseUrl: string;
  readonly detected: readonly DetectedRoleDriver[];
  readonly roles: readonly CaaraCodexRoleDefinition[];
  readonly targetDirectory: string;
  readonly writePlans: readonly RoleWritePlan[];
  readonly yolo: boolean;
}) {
  yield* removeStaleMarkedRoles({ roles, targetDirectory });
  const writtenFiles = yield* Effect.forEach(
    writePlans,
    (plan) =>
      writeRoleFile({
        baseUrl,
        queryParams: plan.queryParams,
        role: plan.role,
        targetDirectory,
        yolo,
      }),
    { concurrency: 1 },
  );
  const skippedDrivers = skippedDriversFromDetected(detected);
  return {
    exitCode: 0,
    message: formatInstallResultMessage({
      skippedDrivers,
      targetDirectory,
      writtenFiles,
    }),
    skippedDrivers,
    targetDirectory,
    writtenFiles,
  } satisfies CaaraCodexRoleInstallResult;
});

/** Builds an install result from managed role preflight output. */
const installResultFromPreflight = Effect.fnUntraced(function* ({
  baseUrl,
  collision,
  detected,
  roles,
  targetDirectory,
  writePlans,
  yolo,
}: {
  readonly baseUrl: string;
  readonly collision: RoleCollisionPlan | undefined;
  readonly detected: readonly DetectedRoleDriver[];
  readonly roles: readonly CaaraCodexRoleDefinition[];
  readonly targetDirectory: string;
  readonly writePlans: readonly RoleWritePlan[];
  readonly yolo: boolean;
}) {
  return yield* Match.value(collision).pipe(
    Match.when(undefined, () =>
      successfulInstallResult({
        baseUrl,
        detected,
        roles,
        targetDirectory,
        writePlans,
        yolo,
      }),
    ),
    Match.orElse(({ filePath }) =>
      Effect.succeed(
        invalidInstallResult({
          message: `caara install-codex-roles refused unmarked existing Codex role: ${filePath}`,
        }),
      ),
    ),
  );
});

/** Runs `caara install-codex-roles` without terminating the host process. */
export const runCaaraInstallCodexRoles = Effect.fnUntraced(function* ({
  args,
  configLoader,
  env = processCodexRoleInstallerEnvironment(),
}: RunCaaraInstallCodexRolesOptions) {
  const options = parseInstallCodexRolesOptions({ args });
  const validationFailure = yield* yoloValidationFailure({ configLoader, env, options });
  const settingsResolution = yield* resolveCaaraSettingsResolutionFromArgs({
    args: options.settingsArgs,
    configLoader,
    env,
  });
  const baseUrl = codexRoleBaseUrlFromSettings({ settings: settingsResolution.settings });
  const targetDirectory = targetDirectoryFromArgs({ args: options.targetArgs, env });
  return yield* Option.match(Option.fromUndefinedOr(validationFailure), {
    onNone: () =>
      Option.match(Option.fromUndefinedOr(targetDirectory), {
        onNone: () =>
          Effect.succeed(
            invalidInstallResult({
              message:
                "caara install-codex-roles requires zero arguments or one target directory, and HOME or CODEX_HOME must be set.",
            }),
          ),
        onSome: (resolvedTargetDirectory) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => fs.mkdir(resolvedTargetDirectory, { recursive: true }),
              catch: (cause) =>
                caaraCodexRoleInstallerError(
                  `Failed to create Codex roles directory ${resolvedTargetDirectory}: ${String(cause)}`,
                ),
            });
            const detected = yield* detectRoleDrivers({ env });
            const roles = rolesFromAvailableDrivers(detected);
            const preflightPlans = yield* preflightRoleWrites({
              roles,
              targetDirectory: resolvedTargetDirectory,
            });
            const collision = firstCollision({ plans: preflightPlans });
            const writePlans = writePlansFromPreflight({ plans: preflightPlans });
            return yield* installResultFromPreflight({
              baseUrl,
              collision,
              detected,
              roles,
              targetDirectory: resolvedTargetDirectory,
              writePlans,
              yolo: options.yolo,
            });
          }),
      }),
    onSome: (message) => Effect.succeed(invalidInstallResult({ message })),
  });
});

/** Runs `caara uninstall-codex-roles` without terminating the host process. */
export const runCaaraUninstallCodexRoles = Effect.fnUntraced(function* ({
  args,
  env = processCodexRoleInstallerEnvironment(),
}: RunCaaraUninstallCodexRolesOptions) {
  const targetDirectory = targetDirectoryFromArgs({ args, env });
  return yield* Option.match(Option.fromUndefinedOr(targetDirectory), {
    onNone: () =>
      Effect.succeed(
        invalidUninstallResult({
          message:
            "caara uninstall-codex-roles requires zero arguments or one target directory, and HOME or CODEX_HOME must be set.",
        }),
      ),
    onSome: (resolvedTargetDirectory) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => fs.mkdir(resolvedTargetDirectory, { recursive: true }),
          catch: (cause) =>
            caaraCodexRoleInstallerError(
              `Failed to create Codex roles directory ${resolvedTargetDirectory}: ${String(cause)}`,
            ),
        });
        const removedFiles = yield* removeMarkedRoles({ targetDirectory: resolvedTargetDirectory });
        return {
          exitCode: 0,
          message: `removed ${removedFiles.length} Codex roles from ${resolvedTargetDirectory}`,
          removedFiles,
          targetDirectory: resolvedTargetDirectory,
        } satisfies CaaraCodexRoleUninstallResult;
      }),
  });
});

/** Runs live `uninstall-codex-roles` and fails for nonzero status. */
export const runCaaraUninstallCodexRolesCli = Effect.fnUntraced(function* ({
  args,
}: RunCaaraUninstallCodexRolesCliOptions) {
  const result = yield* runCaaraUninstallCodexRoles({ args });
  yield* Console.log(result.message);
  return yield* Option.match(
    Option.fromUndefinedOr([result].filter(({ exitCode }) => exitCode !== 0).at(0)),
    {
      onNone: () => Effect.void,
      onSome: (failure) => Effect.fail(caaraCodexRoleInstallerError(failure.message)),
    },
  );
});

/** Runs live `install-codex-roles` and fails for nonzero status. */
export const runCaaraInstallCodexRolesCli = Effect.fnUntraced(function* ({
  args,
}: RunCaaraInstallCodexRolesCliOptions) {
  const result = yield* runCaaraInstallCodexRoles({ args });
  yield* Console.log(result.message);
  return yield* Option.match(
    Option.fromUndefinedOr([result].filter(({ exitCode }) => exitCode !== 0).at(0)),
    {
      onNone: () => Effect.void,
      onSome: (failure) => Effect.fail(caaraCodexRoleInstallerError(failure.message)),
    },
  );
});
