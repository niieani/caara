import path from "node:path";

import { Effect, Option } from "effect";

import { CaaraSettingsError, type CaaraSettingsValue } from "./caaraSettings.ts";

/** Environment values used to resolve Caara child-process execution paths. */
export interface CaaraExecutionPathEnvironment extends Readonly<
  Record<string, string | undefined>
> {
  readonly CAARA_SERVICE?: string | undefined;
  readonly HOME?: string | undefined;
  readonly PATH?: string | undefined;
}

/** Environment map passed to child processes when only PATH needs overriding. */
export type CaaraPathEnvironment = Readonly<Record<"PATH", string>>;

/** Full subprocess environment map passed to SDKs that replace rather than extend env. */
export type CaaraProcessEnvironment = Record<string, string | undefined>;

/** Fixed service PATH suffix used when Caara runs under the installed user service. */
const fixedServicePathEntries = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
] as const;

/** Builds one execution-path validation failure. */
const executionPathError = (message: string): CaaraSettingsError =>
  new CaaraSettingsError({ message });

/** Splits one PATH string into non-empty executable search directories. */
const pathEntriesFromValue = (value: string | undefined): readonly string[] =>
  [value]
    .filter((pathValue): pathValue is string => pathValue !== undefined)
    .flatMap((pathValue) => pathValue.split(path.delimiter))
    .filter((entry) => entry.length > 0);

/** Returns true when Caara is running under its installed user service. */
export const isCaaraServiceMode = ({
  env,
}: {
  readonly env: CaaraExecutionPathEnvironment;
}): boolean => env.CAARA_SERVICE === "1";

/** Resolves HOME for service-mode PATH defaults. */
const serviceHomeDirectory = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraExecutionPathEnvironment;
}) {
  return yield* Option.match(Option.fromUndefinedOr(env.HOME), {
    onNone: () =>
      Effect.fail(executionPathError("Unable to resolve Caara service PATH: HOME is not set.")),
    onSome: Effect.succeed,
  });
});

/** Resolves built-in executable search directories for installed-service runs. */
export const caaraBuiltInServicePathEntries = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraExecutionPathEnvironment;
}) {
  const home = yield* serviceHomeDirectory({ env });
  return [path.join(home, ".local", "bin"), ...fixedServicePathEntries] as const;
});

/** Resolves the suffix appended after config path prefixes for the current run mode. */
const caaraExecutionPathSuffixEntries = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraExecutionPathEnvironment;
}) {
  return yield* Option.match(
    Option.fromUndefinedOr([isCaaraServiceMode({ env })].filter(Boolean).at(0)),
    {
      onNone: () => Effect.succeed(pathEntriesFromValue(env.PATH)),
      onSome: () => caaraBuiltInServicePathEntries({ env }),
    },
  );
});

/** Resolves executable search directories from config prefixes and run-mode defaults. */
export const resolveCaaraExecutionPathEntries = Effect.fnUntraced(function* ({
  settings,
  env,
}: {
  readonly settings: CaaraSettingsValue;
  readonly env: CaaraExecutionPathEnvironment;
}) {
  const suffixEntries = yield* caaraExecutionPathSuffixEntries({ env });
  return [...settings.path, ...suffixEntries] as const;
});

/** Resolves the concrete PATH string used for Caara driver subprocesses. */
export const resolveCaaraExecutionPath = Effect.fnUntraced(function* ({
  settings,
  env,
}: {
  readonly settings: CaaraSettingsValue;
  readonly env: CaaraExecutionPathEnvironment;
}) {
  const entries = yield* resolveCaaraExecutionPathEntries({ settings, env });
  return entries.join(path.delimiter);
});

/** Resolves a minimal child-process environment with Caara's effective PATH. */
export const caaraPathEnvironment = Effect.fnUntraced(function* ({
  settings,
  env,
}: {
  readonly settings: CaaraSettingsValue;
  readonly env: CaaraExecutionPathEnvironment;
}) {
  const PATH = yield* resolveCaaraExecutionPath({ settings, env });
  return { PATH } satisfies CaaraPathEnvironment;
});

/** Resolves a full subprocess environment for SDKs that replace process.env. */
export const caaraProcessEnvironmentWithExecutionPath = Effect.fnUntraced(function* ({
  settings,
  env,
}: {
  readonly settings: CaaraSettingsValue;
  readonly env: CaaraExecutionPathEnvironment;
}) {
  const PATH = yield* resolveCaaraExecutionPath({ settings, env });
  const processEnvironment: CaaraProcessEnvironment = {
    ...env,
    PATH,
  };
  return processEnvironment;
});
