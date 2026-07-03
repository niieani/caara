import { Effect, Layer, Match } from "effect";

import { mainLayerFromArgs } from "./caaraApp.ts";
import { runCaaraDoctorCli } from "./caaraDoctor.ts";
import { runCaaraInstallServiceCli, runCaaraUninstallServiceCli } from "./caaraServiceLifecycle.ts";
import { runCaaraStatusCli } from "./caaraStatus.ts";
import { runCaaraInstallCodexRolesCli } from "./codexRoleInstaller.ts";

/** Selected top-level Caara command after shallow root dispatch. */
export type CaaraCommandSelection =
  | {
      readonly _tag: "Server";
      readonly args: readonly string[];
    }
  | {
      readonly _tag: "Status";
      readonly args: readonly string[];
    }
  | {
      readonly _tag: "Doctor";
      readonly args: readonly string[];
    }
  | {
      readonly _tag: "InstallService";
      readonly args: readonly string[];
    }
  | {
      readonly _tag: "UninstallService";
      readonly args: readonly string[];
    }
  | {
      readonly _tag: "InstallCodexRoles";
      readonly args: readonly string[];
    };

/** Selects the top-level Caara command while preserving default server startup. */
export const selectCaaraCommand = ({
  args,
}: {
  readonly args: readonly string[];
}): CaaraCommandSelection =>
  Match.value(args.at(0)).pipe(
    Match.when(
      "status",
      () =>
        ({
          _tag: "Status",
          args: args.slice(1),
        }) satisfies CaaraCommandSelection,
    ),
    Match.when(
      "doctor",
      () =>
        ({
          _tag: "Doctor",
          args: args.slice(1),
        }) satisfies CaaraCommandSelection,
    ),
    Match.when(
      "install-service",
      () =>
        ({
          _tag: "InstallService",
          args: args.slice(1),
        }) satisfies CaaraCommandSelection,
    ),
    Match.when(
      "uninstall-service",
      () =>
        ({
          _tag: "UninstallService",
          args: args.slice(1),
        }) satisfies CaaraCommandSelection,
    ),
    Match.when(
      "install-codex-roles",
      () =>
        ({
          _tag: "InstallCodexRoles",
          args: args.slice(1),
        }) satisfies CaaraCommandSelection,
    ),
    Match.orElse(
      () =>
        ({
          _tag: "Server",
          args,
        }) satisfies CaaraCommandSelection,
    ),
  );

/** Runs the selected Caara root command. */
export const caaraCliMain = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  const command = selectCaaraCommand({ args });
  return yield* Match.valueTags(command, {
    Server: ({ args: serverArgs }) => Layer.launch(mainLayerFromArgs({ args: serverArgs })),
    Status: ({ args: statusArgs }) => runCaaraStatusCli({ args: statusArgs }),
    Doctor: ({ args: doctorArgs }) => runCaaraDoctorCli({ args: doctorArgs }),
    InstallService: ({ args: installArgs }) => runCaaraInstallServiceCli({ args: installArgs }),
    UninstallService: ({ args: uninstallArgs }) =>
      runCaaraUninstallServiceCli({ args: uninstallArgs }),
    InstallCodexRoles: ({ args: installRoleArgs }) =>
      runCaaraInstallCodexRolesCli({ args: installRoleArgs }),
  });
});
