import { Effect, Match } from "effect";

import { resolveCaaraExecutionPath } from "./caaraExecutionPath.ts";
import type { CaaraServiceLifecycleEnvironment } from "./caaraServiceArtifacts.ts";
import type { CaaraServiceLifecycleResult } from "./caaraServiceInstallNoStart.ts";
import type { CaaraSettingsValue } from "./caaraSettings.ts";
import {
  runCaaraInstallCodexRoles,
  runCaaraUninstallCodexRoles,
  type CaaraCodexRoleInstallResult,
  type CaaraCodexRoleInstallerEnvironment,
} from "./codexRoleInstaller.ts";

/** Seam used by service lifecycle commands to install or remove global Codex roles. */
export interface CaaraServiceCodexRoles {
  readonly install: typeof runCaaraInstallCodexRoles;
  readonly uninstall: typeof runCaaraUninstallCodexRoles;
}

/** Live Codex role lifecycle implementation used by service commands. */
export const liveCaaraServiceCodexRoles: CaaraServiceCodexRoles = {
  install: runCaaraInstallCodexRoles,
  uninstall: runCaaraUninstallCodexRoles,
};

/** Builds the environment passed into standalone Codex role lifecycle commands. */
const codexRoleEnvironment = ({
  env,
  pathValue,
}: {
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly pathValue: string;
}): CaaraCodexRoleInstallerEnvironment => ({
  CODEX_HOME: env.CODEX_HOME,
  HOME: env.HOME,
  PATH: pathValue,
});

/** Builds the environment used to resolve installed service subprocess PATH. */
const serviceModeEnvironment = ({
  env,
}: {
  readonly env: CaaraServiceLifecycleEnvironment;
}): CaaraServiceLifecycleEnvironment => ({
  ...env,
  CAARA_SERVICE: "1",
});

/** Appends role lifecycle output to a service lifecycle command result. */
export const serviceResultWithCodexRoleMessage = ({
  result,
  roleMessage,
}: {
  readonly result: CaaraServiceLifecycleResult;
  readonly roleMessage: string;
}): CaaraServiceLifecycleResult => ({
  ...result,
  message: [result.message, roleMessage].join("\n"),
});

/** Combines service and role lifecycle statuses into one service exit code. */
const serviceResultExitCode = ({
  result,
  roleResult,
}: {
  readonly result: CaaraServiceLifecycleResult;
  readonly roleResult: CaaraServiceLifecycleResult;
}): 0 | 1 =>
  Match.value(result.exitCode === 1 || roleResult.exitCode === 1).pipe(
    Match.when(true, () => 1 as const),
    Match.orElse(() => 0 as const),
  );

/** Appends role lifecycle output and propagates role install failure to service result. */
export const serviceResultWithCodexRoleResult = ({
  result,
  roleResult,
}: {
  readonly result: CaaraServiceLifecycleResult;
  readonly roleResult: CaaraServiceLifecycleResult;
}): CaaraServiceLifecycleResult => ({
  ...result,
  exitCode: serviceResultExitCode({ result, roleResult }),
  message: [result.message, roleResult.message].join("\n"),
});

/** Applies doctor-repaired path entries to settings before role detection. */
export const serviceSettingsWithPathEntries = ({
  appendedPathEntries,
  settings,
}: {
  readonly appendedPathEntries: readonly string[];
  readonly settings: CaaraSettingsValue;
}): CaaraSettingsValue => ({
  ...settings,
  path: [...settings.path, ...appendedPathEntries],
});

/** Builds role installer args for service-driven role installation. */
const installCodexRoleArgs = ({
  configPath,
  yolo,
}: {
  readonly configPath: string;
  readonly yolo: boolean;
}): readonly string[] => [...["--yolo"].filter(() => yolo), "--config", configPath];

/** Returns the service lifecycle result when role installation is intentionally skipped. */
const skippedCodexRoleResult = (): CaaraServiceLifecycleResult => ({
  exitCode: 0,
  message: "Codex role installation skipped",
});

/** Converts standalone role installer output into service install status. */
const serviceCodexRoleResult = ({
  result,
}: {
  readonly result: CaaraCodexRoleInstallResult;
}): CaaraServiceLifecycleResult => {
  const exitCode = Match.value(result.exitCode === 1 || result.writtenFiles.length === 0).pipe(
    Match.when(true, () => 1 as const),
    Match.orElse(() => 0 as const),
  );
  return {
    exitCode,
    message: [
      ...[
        "caara install-service failed because no real external driver executable is available.",
      ].filter(() => result.exitCode === 0 && result.writtenFiles.length === 0),
      result.message,
    ].join("\n"),
  };
};

/** Installs generated Codex roles with the installed service execution path. */
export const installServiceCodexRoles = Effect.fnUntraced(function* ({
  codexRoles,
  configPath,
  env,
  settings,
  skip,
  yolo,
}: {
  readonly codexRoles: CaaraServiceCodexRoles;
  readonly configPath: string;
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly settings: CaaraSettingsValue;
  readonly skip: boolean;
  readonly yolo: boolean;
}) {
  const roleMessages = yield* Effect.forEach(
    [settings].filter(() => !skip),
    (serviceSettings) =>
      Effect.gen(function* () {
        const servicePath = yield* resolveCaaraExecutionPath({
          env: serviceModeEnvironment({ env }),
          settings: serviceSettings,
        });
        const result = yield* codexRoles.install({
          args: installCodexRoleArgs({ configPath, yolo }),
          env: codexRoleEnvironment({ env, pathValue: servicePath }),
        });
        return serviceCodexRoleResult({ result });
      }),
    { concurrency: 1 },
  );
  return roleMessages.at(0) ?? skippedCodexRoleResult();
});

/** Removes Caara-marked generated Codex roles during service uninstall. */
export const uninstallServiceCodexRoles = Effect.fnUntraced(function* ({
  codexRoles,
  env,
}: {
  readonly codexRoles: CaaraServiceCodexRoles;
  readonly env: CaaraServiceLifecycleEnvironment;
}) {
  const result = yield* codexRoles.uninstall({
    args: [],
    env: codexRoleEnvironment({ env, pathValue: env.PATH ?? "" }),
  });
  return result.message;
});
