import fs from "node:fs/promises";
import path from "node:path";

import { Console, Effect, Match, Option } from "effect";

import {
  caaraServiceLifecycleError,
  type CaaraServiceLifecycleEnvironment,
  type CaaraServicePaths,
  type CaaraServicePlatform,
  type CaaraServiceRuntime,
  renderServiceFile,
  resolveServicePaths,
} from "./caaraServiceArtifacts.ts";
import { liveCaaraServiceManager, type CaaraServiceManager } from "./caaraServiceManager.ts";
import { readInstallReceipt, writeInstallReceipt } from "./caaraServiceReceipt.ts";
import {
  type CaaraConfigLoader,
  type CaaraServiceConfigValue,
  type CaaraSettingsResolution,
  type CaaraSettingsValue,
  resolveCaaraSettingsResolutionFromArgs,
} from "./caaraSettings.ts";

export { CaaraServiceLifecycleError } from "./caaraServiceArtifacts.ts";
export { liveCaaraServiceManager } from "./caaraServiceManager.ts";
export type {
  CaaraServiceLifecycleEnvironment,
  CaaraServicePlatform,
  CaaraServiceRuntime,
} from "./caaraServiceArtifacts.ts";
export type { CaaraServiceManager, CaaraServiceManagerRequest } from "./caaraServiceManager.ts";

/** In-process service lifecycle command result. */
export interface CaaraServiceLifecycleResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
}

/** Options accepted by `install-service`. */
export interface RunCaaraInstallServiceOptions {
  readonly args: readonly string[];
  readonly configLoader?: CaaraConfigLoader;
  readonly env?: CaaraServiceLifecycleEnvironment;
  readonly platform?: CaaraServicePlatform;
  readonly runtime?: CaaraServiceRuntime;
}

/** Options accepted by `uninstall-service`. */
export interface RunCaaraUninstallServiceOptions {
  readonly args: readonly string[];
  readonly env?: CaaraServiceLifecycleEnvironment;
  readonly serviceManager?: CaaraServiceManager;
}

/** Options accepted by the live install CLI wrapper. */
export interface RunCaaraInstallServiceCliOptions {
  readonly args: readonly string[];
}

/** Options accepted by the live uninstall CLI wrapper. */
export interface RunCaaraUninstallServiceCliOptions {
  readonly args: readonly string[];
}

/** Parsed install-service options. */
interface InstallServiceOptions {
  readonly noStart: boolean;
  readonly settingsArgs: readonly string[];
  readonly updatesConfig: boolean;
}

/** Parsed uninstall-service options. */
interface UninstallServiceOptions {
  readonly purge: boolean;
}

/** Config write outcome for install-service output. */
type ConfigInstallOutcome =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Preserved" }
  | { readonly _tag: "Updated" };

/** High-level install-service execution mode after shallow validation. */
type InstallServiceExecution =
  | { readonly _tag: "SourceMode" }
  | { readonly _tag: "StartMode" }
  | { readonly _tag: "UnsupportedPlatform" }
  | { readonly _tag: "NoStart" };

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

/** Parses install-service args and strips lifecycle-only flags from settings args. */
const parseInstallServiceOptions = ({
  args,
}: {
  readonly args: readonly string[];
}): InstallServiceOptions => {
  const settingsArgs = args.filter((arg) => arg !== "--no-start");
  return {
    noStart: args.includes("--no-start"),
    settingsArgs,
    updatesConfig: settingsArgs.some(isConfigUpdateArg),
  };
};

/** Parses uninstall-service args. */
const parseUninstallServiceOptions = ({
  args,
}: {
  readonly args: readonly string[];
}): UninstallServiceOptions => ({
  purge: args.includes("--purge"),
});

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
          binaryPath: paths.installedBinaryPath,
          platform,
          serviceId: paths.serviceId,
        }),
        "utf8",
      ),
    catch: (cause) => caaraServiceLifecycleError(`Failed to write service file: ${String(cause)}`),
  });
});

/** Default lifecycle runtime detector for the live CLI. */
const defaultServiceRuntime = (): CaaraServiceRuntime =>
  Match.value(path.basename(process.execPath).startsWith("bun")).pipe(
    Match.when(
      true,
      () => ({ _tag: "Source", executablePath: process.argv[1] ?? process.execPath }) as const,
    ),
    Match.orElse(() => ({ _tag: "Compiled", executablePath: process.execPath }) as const),
  );

/** Default platform detector for the live CLI. */
const defaultServicePlatform = (): CaaraServicePlatform | undefined =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () => "darwin" as const),
    Match.when("linux", () => "linux" as const),
    Match.orElse(() => undefined),
  );

/** Source-mode install-service failure result. */
const sourceModeInstallFailure = (): CaaraServiceLifecycleResult => ({
  exitCode: 1,
  message:
    "caara install-service requires a compiled executable. Run bun run build:service, then dist/caara install-service.",
});

/** Unsupported start-mode failure result for this no-start lifecycle slice. */
const startModeNotImplementedFailure = (): CaaraServiceLifecycleResult => ({
  exitCode: 1,
  message: "caara install-service start mode is not available in this build; use --no-start.",
});

/** Selects the install-service execution mode without performing IO. */
const selectInstallServiceExecution = ({
  options,
  platform,
  runtime,
}: {
  readonly options: InstallServiceOptions;
  readonly platform: CaaraServicePlatform | undefined;
  readonly runtime: CaaraServiceRuntime;
}): InstallServiceExecution =>
  Match.value({
    hasPlatform: platform !== undefined,
    noStart: options.noStart,
    runtimeTag: runtime._tag,
  }).pipe(
    Match.when({ runtimeTag: "Source" }, () => ({ _tag: "SourceMode" }) as const),
    Match.when({ noStart: false }, () => ({ _tag: "StartMode" }) as const),
    Match.when({ hasPlatform: false }, () => ({ _tag: "UnsupportedPlatform" }) as const),
    Match.orElse(() => ({ _tag: "NoStart" }) as const),
  );

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

/** Runs the supported install-service --no-start lifecycle path. */
const runCaaraInstallServiceNoStart = Effect.fnUntraced(function* ({
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
  const paths = yield* resolveServicePaths({ env, platform: servicePlatform });
  const resolution = yield* resolveCaaraSettingsResolutionFromArgs({
    args: options.settingsArgs,
    configLoader,
    env,
  });
  const configOutcome = yield* applyInstallConfig({ options, paths, resolution });
  yield* copyInstalledBinary({
    from: compiledRuntime.executablePath,
    to: paths.installedBinaryPath,
  });
  yield* writeServiceFile({ paths, platform: servicePlatform });
  yield* writeInstallReceipt({ paths });
  return installSuccessResult({ paths, configOutcome });
});

/** Runs `install-service` without terminating the host process. */
export const runCaaraInstallService = Effect.fnUntraced(function* ({
  args,
  configLoader,
  env = process.env,
  platform = defaultServicePlatform(),
  runtime = defaultServiceRuntime(),
}: RunCaaraInstallServiceOptions) {
  const options = parseInstallServiceOptions({ args });
  return yield* Match.valueTags(selectInstallServiceExecution({ options, platform, runtime }), {
    NoStart: () => runCaaraInstallServiceNoStart({ configLoader, env, options, platform, runtime }),
    SourceMode: () => Effect.succeed(sourceModeInstallFailure()),
    StartMode: () => Effect.succeed(startModeNotImplementedFailure()),
    UnsupportedPlatform: () =>
      Effect.fail(caaraServiceLifecycleError(`Unsupported service platform: ${process.platform}`)),
  });
});

/** Removes one path recursively with force. */
const removePath = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  yield* Effect.tryPromise({
    try: () => fs.rm(filePath, { recursive: true, force: true }),
    catch: (cause) => caaraServiceLifecycleError(`Failed to remove ${filePath}: ${String(cause)}`),
  });
});

/** Successful uninstall-service result. */
const uninstallSuccessResult = ({
  purge,
}: {
  readonly purge: boolean;
}): CaaraServiceLifecycleResult => {
  const message = Match.value(purge).pipe(
    Match.when(true, () => "caara uninstall-service complete; config and state purged"),
    Match.orElse(() => "caara uninstall-service complete"),
  );
  return {
    exitCode: 0,
    message,
  };
};

/** Runs `uninstall-service` without terminating the host process. */
export const runCaaraUninstallService = Effect.fnUntraced(function* ({
  args,
  env = process.env,
  serviceManager = liveCaaraServiceManager,
}: RunCaaraUninstallServiceOptions) {
  const options = parseUninstallServiceOptions({ args });
  const platform = defaultServicePlatform() ?? "linux";
  const paths = yield* resolveServicePaths({ env, platform });
  const receipt = yield* readInstallReceipt({ receiptPath: paths.receiptPath });
  yield* serviceManager.unload({
    serviceId: receipt.serviceId,
    serviceFilePath: receipt.serviceFilePath,
  });
  yield* removePath({ filePath: receipt.serviceFilePath });
  yield* removePath({ filePath: receipt.binaryPath });
  yield* removePath({ filePath: paths.receiptPath });
  const purgePaths = Match.value(options.purge).pipe(
    Match.when(true, () => [paths.configDir, paths.stateDir] as const),
    Match.orElse(() => [] as readonly string[]),
  );
  yield* Effect.forEach(purgePaths, (filePath) => removePath({ filePath }), { discard: true });
  return uninstallSuccessResult({ purge: options.purge });
});

/** Runs live `install-service` and fails for nonzero status. */
export const runCaaraInstallServiceCli = Effect.fnUntraced(function* ({
  args,
}: RunCaaraInstallServiceCliOptions) {
  const result = yield* runCaaraInstallService({ args });
  yield* Console.log(result.message);
  return yield* Option.match(
    Option.fromUndefinedOr([result].filter(({ exitCode }) => exitCode !== 0).at(0)),
    {
      onNone: () => Effect.void,
      onSome: (failure) => Effect.fail(caaraServiceLifecycleError(failure.message)),
    },
  );
});

/** Runs live `uninstall-service` and fails for nonzero status. */
export const runCaaraUninstallServiceCli = Effect.fnUntraced(function* ({
  args,
}: RunCaaraUninstallServiceCliOptions) {
  const result = yield* runCaaraUninstallService({ args });
  yield* Console.log(result.message);
  return yield* Option.match(
    Option.fromUndefinedOr([result].filter(({ exitCode }) => exitCode !== 0).at(0)),
    {
      onNone: () => Effect.void,
      onSome: (failure) => Effect.fail(caaraServiceLifecycleError(failure.message)),
    },
  );
});
