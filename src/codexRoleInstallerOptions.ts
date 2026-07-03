import { Effect } from "effect";

import {
  resolveCaaraSettingsResolutionFromArgs,
  type CaaraConfigLoader,
  type CaaraSettingsEnvironment,
} from "./caaraSettings.ts";

/** Parsed standalone install-codex-roles options. */
export interface InstallCodexRolesOptions {
  readonly settingsArgs: readonly string[];
  readonly targetArgs: readonly string[];
  readonly yolo: boolean;
}

/** Returns whether an arg is a config flag consumed by role yolo validation. */
const isConfigArg = (arg: string): boolean => arg === "--config" || arg.startsWith("--config=");

/** Returns whether an arg index is the separated value for `--config`. */
const isSeparatedConfigValueIndex = ({
  args,
  index,
}: {
  readonly args: readonly string[];
  readonly index: number;
}): boolean => args[index - 1] === "--config";

/** Parses install-codex-roles flags separately from the optional target directory. */
export const parseInstallCodexRolesOptions = ({
  args,
}: {
  readonly args: readonly string[];
}): InstallCodexRolesOptions => ({
  settingsArgs: args.filter(
    (arg, index) => isConfigArg(arg) || isSeparatedConfigValueIndex({ args, index }),
  ),
  targetArgs: args.filter(
    (arg, index) =>
      arg !== "--yolo" && !isConfigArg(arg) && !isSeparatedConfigValueIndex({ args, index }),
  ),
  yolo: args.includes("--yolo"),
});

/** Returns a yolo validation failure message when the selected service config lacks the gate. */
export const yoloValidationFailure = Effect.fnUntraced(function* ({
  configLoader,
  env,
  options,
}: {
  readonly configLoader: CaaraConfigLoader | undefined;
  readonly env: CaaraSettingsEnvironment;
  readonly options: InstallCodexRolesOptions;
}) {
  const validationMessages = yield* Effect.forEach(
    [options].filter((installOptions) => installOptions.yolo),
    (installOptions) =>
      Effect.gen(function* () {
        const resolution = yield* resolveCaaraSettingsResolutionFromArgs({
          args: installOptions.settingsArgs,
          configLoader,
          env,
        });
        return [
          "caara install-codex-roles --yolo requires allowDangerousSkipPermissions: true in the selected service config.",
        ]
          .filter(() => !resolution.settings.allowDangerousSkipPermissions)
          .at(0);
      }),
    { concurrency: 1 },
  );
  return validationMessages.find((message) => message !== undefined);
});
