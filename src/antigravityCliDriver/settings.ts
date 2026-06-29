import { Context, Effect, Layer, Option } from "effect";

import { caaraPathEnvironment, type CaaraExecutionPathEnvironment } from "../caaraExecutionPath.ts";
import { CaaraSettings } from "../caaraSettings.ts";

/** Configuration needed by the Antigravity CLI driver to start `agy` turns. */
export interface AntigravityCliSettingsValue {
  readonly command: string;
  readonly homeDir: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** Injectable Antigravity CLI settings used by live code and fake executable tests. */
export class AntigravityCliSettings extends Context.Service<
  AntigravityCliSettings,
  AntigravityCliSettingsValue
>()("@caara/AntigravityCliSettings") {}

/** Selects the first configured HOME-like value for the live Antigravity user-state root. */
const homeDirFromEnv = (env: Readonly<Record<string, string | undefined>>): string =>
  Option.getOrElse(Option.fromUndefinedOr(env.HOME), () => ".");

/** Builds live Antigravity CLI settings from the host process environment. */
export const antigravityCliSettingsFromEnvironment = ({
  env = process.env,
}: {
  readonly env?: CaaraExecutionPathEnvironment;
} = {}) =>
  Layer.effect(
    AntigravityCliSettings,
    Effect.gen(function* () {
      const caaraSettings = yield* CaaraSettings;
      const environment = yield* caaraPathEnvironment({ settings: caaraSettings, env });
      return {
        command: "agy",
        homeDir: homeDirFromEnv(env),
        environment,
      } satisfies AntigravityCliSettingsValue;
    }),
  );
