import fs from "node:fs/promises";
import path from "node:path";

import { Console, Effect, Match, Option } from "effect";

import {
  caaraServiceLifecycleError,
  type CaaraServiceLifecycleEnvironment,
  type CaaraServicePlatform,
  type CaaraServiceRuntime,
  resolveServicePaths,
} from "./caaraServiceArtifacts.ts";
import {
  type CaaraServiceLifecycleResult,
  parseInstallServiceOptions,
  runCaaraInstallServiceNoStart,
} from "./caaraServiceInstallNoStart.ts";
import { liveCaaraServiceManager, type CaaraServiceManager } from "./caaraServiceManager.ts";
import { readInstallReceipt } from "./caaraServiceReceipt.ts";
import {
  liveCaaraServiceDoctor,
  liveCaaraServiceHealthProbe,
  runCaaraInstallServiceStarted,
  type CaaraServiceDoctor,
} from "./caaraServiceStart.ts";
import type { CaaraConfigLoader } from "./caaraSettings.ts";
import type { CaaraHealthProbe } from "./caaraStatus.ts";

export { CaaraServiceLifecycleError } from "./caaraServiceArtifacts.ts";
export { liveCaaraServiceManager } from "./caaraServiceManager.ts";
export type {
  CaaraServiceLifecycleEnvironment,
  CaaraServicePlatform,
  CaaraServiceRuntime,
} from "./caaraServiceArtifacts.ts";
export type { CaaraServiceLifecycleResult } from "./caaraServiceInstallNoStart.ts";
export type { CaaraServiceManager, CaaraServiceManagerRequest } from "./caaraServiceManager.ts";
export type { CaaraServiceDoctor } from "./caaraServiceStart.ts";

/** Options accepted by `install-service`. */
export interface RunCaaraInstallServiceOptions {
  readonly args: readonly string[];
  readonly configLoader?: CaaraConfigLoader;
  readonly doctor?: CaaraServiceDoctor;
  readonly env?: CaaraServiceLifecycleEnvironment;
  readonly healthProbe?: CaaraHealthProbe;
  readonly platform?: CaaraServicePlatform;
  readonly runtime?: CaaraServiceRuntime;
  readonly serviceManager?: CaaraServiceManager;
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

/** Parsed uninstall-service options. */
interface UninstallServiceOptions {
  readonly purge: boolean;
}

/** High-level install-service execution mode after shallow validation. */
type InstallServiceExecution =
  | { readonly _tag: "SourceMode" }
  | { readonly _tag: "Start" }
  | { readonly _tag: "UnsupportedPlatform" }
  | { readonly _tag: "NoStart" };

/** Parses uninstall-service args. */
const parseUninstallServiceOptions = ({
  args,
}: {
  readonly args: readonly string[];
}): UninstallServiceOptions => ({
  purge: args.includes("--purge"),
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

/** Selects the install-service execution mode without performing IO. */
const selectInstallServiceExecution = ({
  noStart,
  platform,
  runtime,
}: {
  readonly noStart: boolean;
  readonly platform: CaaraServicePlatform | undefined;
  readonly runtime: CaaraServiceRuntime;
}): InstallServiceExecution =>
  Match.value({
    hasPlatform: platform !== undefined,
    noStart,
    runtimeTag: runtime._tag,
  }).pipe(
    Match.when({ runtimeTag: "Source" }, () => ({ _tag: "SourceMode" }) as const),
    Match.when({ hasPlatform: false }, () => ({ _tag: "UnsupportedPlatform" }) as const),
    Match.when({ noStart: true }, () => ({ _tag: "NoStart" }) as const),
    Match.orElse(() => ({ _tag: "Start" }) as const),
  );

/** Runs `install-service` without terminating the host process. */
export const runCaaraInstallService = Effect.fnUntraced(function* ({
  args,
  configLoader,
  doctor = liveCaaraServiceDoctor,
  env = process.env,
  healthProbe = liveCaaraServiceHealthProbe,
  platform = defaultServicePlatform(),
  runtime = defaultServiceRuntime(),
  serviceManager = liveCaaraServiceManager,
}: RunCaaraInstallServiceOptions) {
  const options = parseInstallServiceOptions({ args });
  return yield* Match.valueTags(
    selectInstallServiceExecution({ noStart: options.noStart, platform, runtime }),
    {
      NoStart: () =>
        runCaaraInstallServiceNoStart({ configLoader, env, options, platform, runtime }),
      SourceMode: () => Effect.succeed(sourceModeInstallFailure()),
      Start: () =>
        runCaaraInstallServiceStarted({
          configLoader,
          doctor,
          env,
          healthProbe,
          options,
          platform,
          runtime,
          serviceManager,
        }),
      UnsupportedPlatform: () =>
        Effect.fail(
          caaraServiceLifecycleError(`Unsupported service platform: ${process.platform}`),
        ),
    },
  );
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
    Match.when(true, () => [path.dirname(receipt.configPath), paths.stateDir] as const),
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
