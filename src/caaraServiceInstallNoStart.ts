import fs from "node:fs/promises";
import path from "node:path";

import { Effect, Match, Option } from "effect";

import {
  caaraServiceLifecycleError,
  type CaaraServiceLifecycleEnvironment,
  type CaaraServicePaths,
  type CaaraServicePlatform,
  type CaaraServiceRuntime,
  renderServiceFile,
  resolveServicePaths,
} from "./caaraServiceArtifacts.ts";
import { writeInstallReceipt } from "./caaraServiceReceipt.ts";
import {
  type CaaraConfigLoader,
  type CaaraServiceConfigValue,
  type CaaraSettingsResolution,
  type CaaraSettingsValue,
  resolveCaaraSettingsResolutionFromArgs,
} from "./caaraSettings.ts";

/** In-process service lifecycle command result. */
export interface CaaraServiceLifecycleResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
}

/** Parsed install-service options. */
export interface InstallServiceOptions {
  readonly noInstallCodexRoles: boolean;
  readonly noStart: boolean;
  readonly settingsArgs: readonly string[];
  readonly updatesConfig: boolean;
}

/** Result of writing service artifacts without starting the service. */
export interface NoStartInstallOutcome {
  readonly paths: CaaraServicePaths;
  readonly resolution: CaaraSettingsResolution;
  readonly result: CaaraServiceLifecycleResult;
}

/** Config write outcome for install-service output. */
type ConfigInstallOutcome =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Preserved" }
  | { readonly _tag: "Updated" };

/** Returns one flag name without an inline `=<value>` suffix. */
const rawFlagName = (arg: string): string =>
  [arg.indexOf("=")]
    .filter((equalsIndex) => equalsIndex >= 0)
    .map((equalsIndex) => arg.slice(0, equalsIndex))
    .at(0) ?? arg;

/** Returns true when one forwarded settings arg changes config values. */
const isConfigUpdateArg = (arg: string): boolean =>
  new Set([
    "--allow-dangerous-skip-permissions",
    "--host",
    "--no-allow-dangerous-skip-permissions",
    "--port",
  ]).has(rawFlagName(arg));

/** Returns true when one arg is consumed by service lifecycle rather than settings. */
const isInstallLifecycleArg = (arg: string): boolean =>
  new Set(["--no-install-codex-roles", "--no-start"]).has(arg);

/** Parses install-service args and strips lifecycle-only flags from settings args. */
export const parseInstallServiceOptions = ({
  args,
}: {
  readonly args: readonly string[];
}): InstallServiceOptions => {
  const settingsArgs = args.filter((arg) => !isInstallLifecycleArg(arg));
  return {
    noInstallCodexRoles: args.includes("--no-install-codex-roles"),
    noStart: args.includes("--no-start"),
    settingsArgs,
    updatesConfig: settingsArgs.some(isConfigUpdateArg),
  };
};

/** Builds a strict config document from resolved settings. */
const configFromSettings = (settings: CaaraSettingsValue): CaaraServiceConfigValue => {
  const logFileConfig = Option.match(Option.fromUndefinedOr(settings.logFile), {
    onNone: () => ({}),
    onSome: (logFile) => ({ logFile }),
  });
  return {
    host: settings.host,
    port: settings.port,
    allowDangerousSkipPermissions: settings.allowDangerousSkipPermissions,
    path: settings.path,
    ...logFileConfig,
  };
};

/** Writes one YAML config document. */
const writeServiceConfig = Effect.fnUntraced(function* ({
  configPath,
  config,
}: {
  readonly configPath: string;
  readonly config: CaaraServiceConfigValue;
}) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(configPath), { recursive: true }),
    catch: (cause) =>
      caaraServiceLifecycleError(`Failed to create Caara config directory: ${String(cause)}`),
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(configPath, `${Bun.YAML.stringify(config, null, 2)}\n`, "utf8"),
    catch: (cause) => caaraServiceLifecycleError(`Failed to write Caara config: ${String(cause)}`),
  });
});

/** Applies install-service config create/preserve/update semantics. */
const applyInstallConfig = Effect.fnUntraced(function* ({
  options,
  paths,
  resolution,
}: {
  readonly options: InstallServiceOptions;
  readonly paths: CaaraServicePaths;
  readonly resolution: CaaraSettingsResolution;
}) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(paths.configPath).exists(),
    catch: () => false,
  });
  return yield* Match.value({ exists, updates: options.updatesConfig }).pipe(
    Match.when({ exists: true, updates: false }, () =>
      Effect.succeed({ _tag: "Preserved" } satisfies ConfigInstallOutcome),
    ),
    Match.when({ exists: true, updates: true }, () =>
      Effect.gen(function* () {
        yield* writeServiceConfig({
          configPath: paths.configPath,
          config: configFromSettings(resolution.settings),
        });
        return { _tag: "Updated" } satisfies ConfigInstallOutcome;
      }),
    ),
    Match.orElse(() =>
      Effect.gen(function* () {
        yield* writeServiceConfig({
          configPath: paths.configPath,
          config: configFromSettings(resolution.settings),
        });
        return { _tag: "Created" } satisfies ConfigInstallOutcome;
      }),
    ),
  );
});

/** Replaces default config paths with the absolute config path selected by settings resolution. */
const servicePathsWithResolvedConfig = ({
  paths,
  resolution,
}: {
  readonly paths: CaaraServicePaths;
  readonly resolution: CaaraSettingsResolution;
}): CaaraServicePaths => {
  const configPath = path.resolve(resolution.configPath);
  return {
    ...paths,
    configPath,
    configDir: path.dirname(configPath),
  };
};

/** User-facing text for one config install outcome. */
const configOutcomeText = (outcome: ConfigInstallOutcome): string =>
  Match.valueTags(outcome, {
    Created: () => "config created",
    Preserved: () => "config preserved",
    Updated: () => "config updated",
  });

/** Copies the current compiled executable to the installer-managed user bin path. */
const copyInstalledBinary = Effect.fnUntraced(function* ({
  from,
  to,
}: {
  readonly from: string;
  readonly to: string;
}) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(to), { recursive: true }),
    catch: (cause) =>
      caaraServiceLifecycleError(`Failed to create Caara bin directory: ${String(cause)}`),
  });
  yield* Effect.tryPromise({
    try: () => fs.copyFile(from, to),
    catch: (cause) =>
      caaraServiceLifecycleError(`Failed to install Caara binary: ${String(cause)}`),
  });
  yield* Effect.tryPromise({
    try: () => fs.chmod(to, 0o755),
    catch: (cause) =>
      caaraServiceLifecycleError(`Failed to mark Caara binary executable: ${String(cause)}`),
  });
});

/** Writes the platform-specific service manager file. */
const writeServiceFile = Effect.fnUntraced(function* ({
  paths,
  platform,
}: {
  readonly paths: CaaraServicePaths;
  readonly platform: CaaraServicePlatform;
}) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(paths.serviceFilePath), { recursive: true }),
    catch: (cause) =>
      caaraServiceLifecycleError(`Failed to create service directory: ${String(cause)}`),
  });
  yield* Effect.tryPromise({
    try: () =>
      fs.writeFile(
        paths.serviceFilePath,
        renderServiceFile({
          platform,
          program: {
            binaryPath: paths.installedBinaryPath,
            args: ["--config", paths.configPath],
          },
          serviceId: paths.serviceId,
        }),
        "utf8",
      ),
    catch: (cause) => caaraServiceLifecycleError(`Failed to write service file: ${String(cause)}`),
  });
});

/** Returns the compiled runtime or fails if the caller selected the wrong install branch. */
const requireCompiledRuntime = Effect.fnUntraced(function* ({
  runtime,
}: {
  readonly runtime: CaaraServiceRuntime;
}) {
  return yield* Option.match(
    Option.fromUndefinedOr(
      [runtime]
        .filter(
          (candidate): candidate is Extract<CaaraServiceRuntime, { readonly _tag: "Compiled" }> =>
            candidate._tag === "Compiled",
        )
        .at(0),
    ),
    {
      onNone: () =>
        Effect.die(new Error("install-service no-start branch requires compiled runtime")),
      onSome: Effect.succeed,
    },
  );
});

/** Returns the selected service platform or fails with a user-facing lifecycle error. */
const requireServicePlatform = Effect.fnUntraced(function* ({
  platform,
}: {
  readonly platform: CaaraServicePlatform | undefined;
}) {
  return yield* Option.match(Option.fromUndefinedOr(platform), {
    onNone: () =>
      Effect.fail(caaraServiceLifecycleError(`Unsupported service platform: ${process.platform}`)),
    onSome: Effect.succeed,
  });
});

/** Successful install-service --no-start result. */
const installSuccessResult = ({
  paths,
  configOutcome,
}: {
  readonly paths: CaaraServicePaths;
  readonly configOutcome: ConfigInstallOutcome;
}): CaaraServiceLifecycleResult => ({
  exitCode: 0,
  message: [
    "caara install-service --no-start complete",
    configOutcomeText(configOutcome),
    `binary ${paths.installedBinaryPath}`,
    `service ${paths.serviceFilePath}`,
    `receipt ${paths.receiptPath}`,
  ].join("\n"),
});

/** Writes all install-service artifacts without starting the service. */
export const installServiceNoStartArtifacts = Effect.fnUntraced(function* ({
  configLoader,
  env,
  options,
  platform,
  runtime,
}: {
  readonly configLoader: CaaraConfigLoader | undefined;
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly options: InstallServiceOptions;
  readonly platform: CaaraServicePlatform | undefined;
  readonly runtime: CaaraServiceRuntime;
}) {
  const compiledRuntime = yield* requireCompiledRuntime({ runtime });
  const servicePlatform = yield* requireServicePlatform({ platform });
  const defaultPaths = yield* resolveServicePaths({ env, platform: servicePlatform });
  const resolution = yield* resolveCaaraSettingsResolutionFromArgs({
    args: options.settingsArgs,
    configLoader,
    env,
  });
  const paths = servicePathsWithResolvedConfig({ paths: defaultPaths, resolution });
  const configOutcome = yield* applyInstallConfig({ options, paths, resolution });
  yield* copyInstalledBinary({
    from: compiledRuntime.executablePath,
    to: paths.installedBinaryPath,
  });
  yield* writeServiceFile({ paths, platform: servicePlatform });
  yield* writeInstallReceipt({ paths });
  return {
    paths,
    resolution,
    result: installSuccessResult({ paths, configOutcome }),
  } satisfies NoStartInstallOutcome;
});

/** Runs the supported install-service --no-start lifecycle path. */
export const runCaaraInstallServiceNoStart = Effect.fnUntraced(function* ({
  configLoader,
  env,
  options,
  platform,
  runtime,
}: {
  readonly configLoader: CaaraConfigLoader | undefined;
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly options: InstallServiceOptions;
  readonly platform: CaaraServicePlatform | undefined;
  readonly runtime: CaaraServiceRuntime;
}) {
  const outcome = yield* installServiceNoStartArtifacts({
    configLoader,
    env,
    options,
    platform,
    runtime,
  });
  return outcome.result;
});
