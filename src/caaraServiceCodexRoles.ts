import { Effect } from "effect";

import { resolveCaaraExecutionPath } from "./caaraExecutionPath.ts";
import type { CaaraServiceLifecycleEnvironment } from "./caaraServiceArtifacts.ts";
import type { CaaraServiceLifecycleResult } from "./caaraServiceInstallNoStart.ts";
import type { CaaraSettingsValue } from "./caaraSettings.ts";
import {
  runCaaraInstallCodexRoles,
  runCaaraUninstallCodexRoles,
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

/** Installs generated Codex roles with the installed service execution path. */
export const installServiceCodexRoles = Effect.fnUntraced(function* ({
  codexRoles,
  env,
  settings,
  skip,
}: {
  readonly codexRoles: CaaraServiceCodexRoles;
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly settings: CaaraSettingsValue;
  readonly skip: boolean;
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
          args: [],
          env: codexRoleEnvironment({ env, pathValue: servicePath }),
        });
        return result.message;
      }),
    { concurrency: 1 },
  );
  return roleMessages.at(0) ?? "Codex role installation skipped";
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
