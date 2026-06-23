import { Context, Layer, Option } from "effect";

/** Configuration needed by the Antigravity CLI driver to start `agy` turns. */
export interface AntigravityCliSettingsValue {
  readonly command: string;
  readonly homeDir: string;
  readonly allowDangerousSkipPermissions: boolean;
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
  readonly env?: Readonly<Record<string, string | undefined>>;
} = {}) =>
  Layer.succeed(AntigravityCliSettings, {
    command: "agy",
    homeDir: homeDirFromEnv(env),
    allowDangerousSkipPermissions: false,
    environment: {},
  });
