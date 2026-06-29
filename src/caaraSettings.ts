import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, Match, Option, Ref, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

/** Runtime-wide Caara settings shared by the server and external-agent drivers. */
export interface CaaraSettingsValue {
  readonly host: string;
  readonly port: number;
  readonly allowDangerousSkipPermissions: boolean;
  readonly path: readonly string[];
  readonly logFile: string | undefined;
}

/** Environment shape used to resolve default Caara config paths. */
export interface CaaraSettingsEnvironment extends Readonly<Record<string, string | undefined>> {
  readonly HOME?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
}

/** File loader seam for Caara YAML config resolution. */
export type CaaraConfigLoadEffect = EffectContract<string | undefined, CaaraSettingsError>;

/** File loader seam for Caara YAML config resolution. */
export interface CaaraConfigLoader {
  readonly read: (configPath: string) => CaaraConfigLoadEffect;
}

/** Parsed root command flags before YAML/default precedence is applied. */
interface CaaraCliOptions {
  readonly configPath: string | undefined;
  readonly host: string | undefined;
  readonly port: string | undefined;
  readonly allowDangerousSkipPermissions: boolean | undefined;
}

/** Selected config path and whether it came from an explicit CLI flag. */
interface SelectedConfigPath {
  readonly configPath: string;
  readonly explicit: boolean;
}

/** Full settings resolution result with the config document that produced it. */
export interface CaaraSettingsResolution {
  readonly settings: CaaraSettingsValue;
  readonly configPath: string;
  readonly configExplicit: boolean;
  readonly config: CaaraServiceConfigValue;
}

/** Startup settings validation failure for the Caara process. */
export class CaaraSettingsError extends Schema.TaggedErrorClass<CaaraSettingsError>()(
  "CaaraSettingsError",
  {
    message: Schema.String,
  },
) {}

/** Injectable runtime-wide Caara settings service. */
export class CaaraSettings extends Context.Service<CaaraSettings, CaaraSettingsValue>()(
  "@caara/CaaraSettings",
) {}

/** Default HTTP port for the local Responses-compatible Caara server. */
export const defaultCaaraPort = 8787;

/** Built-in Caara settings used when YAML and CLI do not override them. */
export const defaultCaaraSettingsValue: CaaraSettingsValue = {
  host: "127.0.0.1",
  port: defaultCaaraPort,
  allowDangerousSkipPermissions: false,
  path: [],
  logFile: undefined,
};

/** Lowest TCP port value accepted by startup and config parsing. */
const minPort = 1;

/** Highest TCP port value accepted by startup and config parsing. */
const maxPort = 65_535;

/** Config keys accepted in Caara service YAML. */
const caaraServiceConfigKeys = new Set([
  "host",
  "port",
  "allowDangerousSkipPermissions",
  "path",
  "logFile",
]);

/** Strict decoded shape for one Caara service YAML document. */
const CaaraServiceConfig = Schema.Struct({
  host: Schema.optionalKey(Schema.NonEmptyString),
  port: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(minPort), Schema.isLessThanOrEqualTo(maxPort)),
  ),
  allowDangerousSkipPermissions: Schema.optionalKey(Schema.Boolean),
  path: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  logFile: Schema.optionalKey(Schema.NonEmptyString),
});

/** Strict decoded type for one Caara service YAML document. */
export type CaaraServiceConfigValue = typeof CaaraServiceConfig.Type;

/** Builds a startup settings validation failure. */
const caaraSettingsError = (message: string): CaaraSettingsError =>
  new CaaraSettingsError({ message });

/** Resolves the config home directory candidate from explicit XDG or HOME. */
const configHomeFromEnvironment = ({
  env,
}: {
  readonly env: CaaraSettingsEnvironment;
}): string | undefined =>
  env.XDG_CONFIG_HOME ??
  [env.HOME]
    .filter((home): home is string => home !== undefined)
    .map((home) => path.join(home, ".config"))
    .at(0);

/** Returns the default user-local Caara YAML config path for an environment. */
export const defaultCaaraConfigPath = ({
  env,
}: {
  readonly env: CaaraSettingsEnvironment;
}): string => path.join(configHomeFromEnvironment({ env }) ?? "", "caara", "config.yaml");

/** Resolves the default config path, failing when neither XDG_CONFIG_HOME nor HOME is available. */
const resolveDefaultCaaraConfigPath = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraSettingsEnvironment;
}) {
  return yield* Option.match(Option.fromUndefinedOr(configHomeFromEnvironment({ env })), {
    onNone: () =>
      Effect.fail(
        caaraSettingsError("Unable to resolve Caara config path: set XDG_CONFIG_HOME or HOME."),
      ),
    onSome: (configHome) => Effect.succeed(path.join(configHome, "caara", "config.yaml")),
  });
});

/** Live Bun-backed Caara config loader. */
export const bunCaaraConfigLoader: CaaraConfigLoader = {
  read: Effect.fnUntraced(function* (configPath: string) {
    const file = Bun.file(configPath);
    const exists = yield* Effect.tryPromise({
      try: () => file.exists(),
      catch: () => caaraSettingsError(`Failed to inspect Caara config path: ${configPath}.`),
    });

    return yield* Option.match(Option.fromUndefinedOr([file].filter(() => exists).at(0)), {
      onNone: () => Effect.map(Effect.void, (): string | undefined => undefined),
      onSome: (readableFile) =>
        Effect.tryPromise({
          try: () => readableFile.text(),
          catch: () => caaraSettingsError(`Failed to read Caara config: ${configPath}.`),
        }),
    });
  }),
};

/** Returns true when an unknown YAML value is a non-array object. */
const isConfigRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates that config YAML contains no unknown top-level keys. */
const rejectUnknownConfigKeys = Effect.fnUntraced(function* ({
  config,
}: {
  readonly config: Readonly<Record<string, unknown>>;
}) {
  const unknownKey = Object.keys(config)
    .filter((key) => !caaraServiceConfigKeys.has(key))
    .at(0);

  return yield* Option.match(Option.fromUndefinedOr(unknownKey), {
    onNone: () => Effect.void,
    onSome: (key) => Effect.fail(caaraSettingsError(`Unknown Caara config key: ${key}.`)),
  });
});

/** Parses raw YAML text with Bun's YAML parser. */
const parseRawYaml = Effect.fnUntraced(function* ({ yaml }: { readonly yaml: string }) {
  return yield* Effect.try({
    try: () => Bun.YAML.parse(yaml),
    catch: (cause) => caaraSettingsError(`Failed to parse Caara config YAML: ${String(cause)}.`),
  });
});

/** Decodes and validates one parsed YAML config document. */
const decodeConfigDocument = Effect.fnUntraced(function* ({
  document,
}: {
  readonly document: unknown;
}) {
  const configRecord = yield* Option.match(
    Option.fromUndefinedOr([document].filter(isConfigRecord).at(0)),
    {
      onNone: () => Effect.fail(caaraSettingsError("Caara config YAML must be a mapping object.")),
      onSome: Effect.succeed,
    },
  );

  yield* rejectUnknownConfigKeys({ config: configRecord });
  return yield* Schema.decodeUnknownEffect(CaaraServiceConfig, {
    errors: "all",
    onExcessProperty: "error",
  })(configRecord).pipe(
    Effect.mapError((cause) => caaraSettingsError(`Invalid Caara config: ${String(cause)}.`)),
  );
});

/** Returns the first absolute-path validation failure for a decoded config. */
const configPathValidationError = ({
  config,
}: {
  readonly config: CaaraServiceConfigValue;
}): string | undefined => {
  const relativePrefixError = config.path
    ?.filter((entry) => !path.isAbsolute(entry))
    .map((entry) => `Caara config path entries must be absolute directories: ${entry}.`)
    .at(0);
  const logFileError = [config.logFile]
    .filter((logFile): logFile is string => logFile !== undefined && !path.isAbsolute(logFile))
    .map((logFile) => `Caara config logFile must be absolute: ${logFile}.`)
    .at(0);

  return [relativePrefixError, logFileError]
    .filter((message): message is string => message !== undefined)
    .at(0);
};

/** Validates absolute-path-only config fields after schema decoding. */
const validateConfigPaths = Effect.fnUntraced(function* (config: CaaraServiceConfigValue) {
  return yield* Option.match(Option.fromUndefinedOr(configPathValidationError({ config })), {
    onNone: () => Effect.succeed(config),
    onSome: (message) => Effect.fail(caaraSettingsError(message)),
  });
});

/** Parses and validates one Caara service YAML config document. */
export const parseCaaraServiceConfigYaml = Effect.fnUntraced(function* ({
  yaml,
}: {
  readonly yaml: string;
}) {
  const parsed = yield* parseRawYaml({ yaml });

  const document = yield* Match.value(parsed).pipe(
    Match.when(Array.isArray, () =>
      Effect.fail(caaraSettingsError("Caara config YAML must contain exactly one YAML document.")),
    ),
    Match.orElse(Effect.succeed),
  );
  const config = yield* decodeConfigDocument({ document });
  return yield* validateConfigPaths(config);
});

/** Converts optional CLI flag values from Effect CLI into plain optional values. */
const optionToUndefined = <A>(option: Option.Option<A>): A | undefined =>
  Option.getOrUndefined(option);

/** Returns true when a raw startup arg looks like another option flag. */
const isOptionFlag = (value: string): boolean => value.startsWith("--");

/** Returns one flag name without an inline `=<value>` suffix. */
const rawFlagName = (arg: string): string =>
  [arg.indexOf("=")]
    .filter((equalsIndex) => equalsIndex >= 0)
    .map((equalsIndex) => arg.slice(0, equalsIndex))
    .at(0) ?? arg;

/** Returns an unsupported-flag error message for one raw arg when applicable. */
const unsupportedRawFlagError = ({
  arg,
  supportedFlags,
}: {
  readonly arg: string;
  readonly supportedFlags: ReadonlySet<string>;
}): string | undefined =>
  [rawFlagName(arg)]
    .filter(() => arg.startsWith("-"))
    .filter((flagName) => !supportedFlags.has(flagName))
    .map((flagName) => `Unsupported Caara server option: ${flagName}.`)
    .at(0);

/** Returns a missing separated flag value error for one raw arg when applicable. */
const missingSeparatedValueError = ({
  arg,
  index,
  args,
  valueFlags,
}: {
  readonly arg: string;
  readonly index: number;
  readonly args: readonly string[];
  readonly valueFlags: ReadonlySet<string>;
}): string | undefined =>
  [arg]
    .filter((flagName) => valueFlags.has(flagName))
    .filter(() =>
      Option.isNone(
        Option.fromUndefinedOr(args.at(index + 1)).pipe(
          Option.filter((value) => !isOptionFlag(value)),
        ),
      ),
    )
    .map((flagName) => `Caara ${flagName} requires a value.`)
    .at(0);

/** Returns a missing inline `--flag=` value error for one raw arg when applicable. */
const missingInlineValueError = ({
  arg,
  valueFlags,
}: {
  readonly arg: string;
  readonly valueFlags: ReadonlySet<string>;
}): string | undefined =>
  [rawFlagName(arg)]
    .filter((flagName) => valueFlags.has(flagName))
    .filter(() => arg.includes("="))
    .filter(() => arg.slice(arg.indexOf("=") + 1).length === 0)
    .map((flagName) => `Caara ${flagName} requires a value.`)
    .at(0);

/** Returns the first raw CLI validation failure before Effect CLI parsing. */
const rawCliFlagValidationError = ({
  args,
}: {
  readonly args: readonly string[];
}): string | undefined => {
  const valueFlags = new Set(["--config", "--host", "--port"]);
  const supportedFlags = new Set([
    "--allow-dangerous-skip-permissions",
    "--no-allow-dangerous-skip-permissions",
    "--config",
    "--help",
    "--host",
    "--port",
    "--version",
    "-h",
    "-v",
  ]);

  return args
    .flatMap((arg, index) => [
      unsupportedRawFlagError({ arg, supportedFlags }),
      missingSeparatedValueError({ arg, index, args, valueFlags }),
      missingInlineValueError({ arg, valueFlags }),
    ])
    .filter((message): message is string => message !== undefined)
    .at(0);
};

/** Fails when raw CLI args are invalid before Effect CLI parsing. */
const validateRawCliFlags = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  return yield* Option.match(Option.fromUndefinedOr(rawCliFlagValidationError({ args })), {
    onNone: () => Effect.void,
    onSome: (message) => Effect.fail(caaraSettingsError(message)),
  });
});

/** Builds the root Caara command for settings parsing. */
const caaraSettingsCommand = ({
  optionsRef,
}: {
  readonly optionsRef: Ref.Ref<Option.Option<CaaraCliOptions>>;
}) =>
  Command.make(
    "caara",
    {
      configPath: Flag.optional(Flag.string("config")),
      host: Flag.optional(Flag.string("host")),
      port: Flag.optional(Flag.string("port")),
      allowDangerousSkipPermissions: Flag.optional(
        Flag.boolean("allow-dangerous-skip-permissions"),
      ),
    },
    (input) =>
      Ref.set(
        optionsRef,
        Option.some({
          configPath: optionToUndefined(input.configPath),
          host: optionToUndefined(input.host),
          port: optionToUndefined(input.port),
          allowDangerousSkipPermissions: optionToUndefined(input.allowDangerousSkipPermissions),
        }),
      ),
  );

/** Parses root Caara CLI flags through Effect CLI. */
export const parseCaaraCliOptions = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  const optionsRef = yield* Ref.make(Option.none<CaaraCliOptions>());

  yield* validateRawCliFlags({ args });
  yield* Command.runWith(caaraSettingsCommand({ optionsRef }), {
    version: "0.0.0",
  })(args).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError((cause) => caaraSettingsError(String(cause))),
  );

  return yield* Ref.get(optionsRef).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(caaraSettingsError("Caara CLI options were not parsed.")),
        onSome: Effect.succeed,
      }),
    ),
  );
});

/** Selects the YAML config path from CLI or default XDG paths. */
const selectConfigPath = Effect.fnUntraced(function* ({
  cliOptions,
  env,
}: {
  readonly cliOptions: CaaraCliOptions;
  readonly env: CaaraSettingsEnvironment;
}) {
  const configPathOption = Option.fromUndefinedOr(cliOptions.configPath);
  const explicit = Option.isSome(configPathOption);
  const configPath = yield* Option.match(configPathOption, {
    onNone: () => resolveDefaultCaaraConfigPath({ env }),
    onSome: Effect.succeed,
  });
  return { configPath, explicit } satisfies SelectedConfigPath;
});

/** Reads and parses config YAML, preserving missing default config as an empty config. */
const loadSelectedConfig = Effect.fnUntraced(function* ({
  selected,
  configLoader,
}: {
  readonly selected: SelectedConfigPath;
  readonly configLoader: CaaraConfigLoader;
}) {
  const yaml = yield* configLoader.read(selected.configPath);
  const missingConfig = Match.value(selected.explicit).pipe(
    Match.when(true, () =>
      Effect.fail(
        caaraSettingsError(`Explicit Caara --config path does not exist: ${selected.configPath}.`),
      ),
    ),
    Match.orElse(() => Effect.succeed({} satisfies CaaraServiceConfigValue)),
  );

  return yield* Match.value(yaml).pipe(
    Match.when(undefined, () => missingConfig),
    Match.orElse((content) => parseCaaraServiceConfigYaml({ yaml: content })),
  );
});

/** Parses one port string from CLI overrides. */
const parsePortValue = Effect.fnUntraced(function* ({ value }: { readonly value: string }) {
  const parsed = [/^[0-9]+$/u.test(value)]
    .filter(Boolean)
    .map(() => Number(value))
    .filter((candidate) => Number.isInteger(candidate))
    .filter((candidate) => candidate >= minPort)
    .filter((candidate) => candidate <= maxPort)
    .at(0);

  return yield* Option.match(Option.fromUndefinedOr(parsed), {
    onNone: () =>
      Effect.fail(caaraSettingsError("Caara --port must be an integer from 1 to 65535.")),
    onSome: Effect.succeed,
  });
});

/** Validates one CLI host override. */
const validateCliHost = Effect.fnUntraced(function* ({ value }: { readonly value: string }) {
  return yield* Option.match(
    Option.fromUndefinedOr([value].filter((host) => host.length > 0).at(0)),
    {
      onNone: () => Effect.fail(caaraSettingsError("Caara --host must be a non-empty string.")),
      onSome: Effect.succeed,
    },
  );
});

/** Parses an optional CLI port override while preserving absence as undefined. */
const parseOptionalPortValue = Effect.fnUntraced(function* ({
  value,
}: {
  readonly value: string | undefined;
}) {
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, (): number | undefined => undefined),
    onSome: (portValue) => parsePortValue({ value: portValue }),
  });
});

/** Validates an optional CLI host override while preserving absence as undefined. */
const validateOptionalCliHost = Effect.fnUntraced(function* ({
  value,
}: {
  readonly value: string | undefined;
}) {
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, (): string | undefined => undefined),
    onSome: (hostValue) => validateCliHost({ value: hostValue }),
  });
});

/** Applies config and CLI values over built-in defaults. */
const mergeSettings = Effect.fnUntraced(function* ({
  config,
  cliOptions,
}: {
  readonly config: CaaraServiceConfigValue;
  readonly cliOptions: CaaraCliOptions;
}) {
  const cliPort = yield* parseOptionalPortValue({ value: cliOptions.port });
  const cliHost = yield* validateOptionalCliHost({ value: cliOptions.host });

  return {
    host: cliHost ?? config.host ?? defaultCaaraSettingsValue.host,
    port: cliPort ?? config.port ?? defaultCaaraSettingsValue.port,
    allowDangerousSkipPermissions:
      cliOptions.allowDangerousSkipPermissions ??
      config.allowDangerousSkipPermissions ??
      defaultCaaraSettingsValue.allowDangerousSkipPermissions,
    path: config.path ?? defaultCaaraSettingsValue.path,
    logFile: config.logFile ?? defaultCaaraSettingsValue.logFile,
  } satisfies CaaraSettingsValue;
});

/** Resolves Caara settings plus the selected YAML config document from root CLI args. */
export const resolveCaaraSettingsResolutionFromArgs = Effect.fnUntraced(function* ({
  args,
  env = process.env,
  configLoader = bunCaaraConfigLoader,
}: {
  readonly args: readonly string[];
  readonly env?: CaaraSettingsEnvironment;
  readonly configLoader?: CaaraConfigLoader;
}) {
  const cliOptions = yield* parseCaaraCliOptions({ args });
  const selected = yield* selectConfigPath({ cliOptions, env });
  const config = yield* loadSelectedConfig({ selected, configLoader });
  const settings = yield* mergeSettings({ config, cliOptions });
  return {
    settings,
    configPath: selected.configPath,
    configExplicit: selected.explicit,
    config,
  } satisfies CaaraSettingsResolution;
});

/** Resolves Caara settings from root CLI args, YAML config, and built-in defaults. */
export const resolveCaaraSettingsFromArgs = Effect.fnUntraced(function* ({
  args,
  env = process.env,
  configLoader = bunCaaraConfigLoader,
}: {
  readonly args: readonly string[];
  readonly env?: CaaraSettingsEnvironment;
  readonly configLoader?: CaaraConfigLoader;
}) {
  const resolution = yield* resolveCaaraSettingsResolutionFromArgs({ args, env, configLoader });
  return resolution.settings;
});

/** Builds a Caara settings layer from a concrete settings value. */
export const caaraSettingsLayerFromValue = ({
  settings,
}: {
  readonly settings: CaaraSettingsValue;
}) => Layer.succeed(CaaraSettings, settings);

/** Builds a Caara settings layer by resolving already-split startup args. */
export const caaraSettingsLayerFromArgs = ({ args }: { readonly args: readonly string[] }) =>
  Layer.effect(CaaraSettings, resolveCaaraSettingsFromArgs({ args }));

/** Default Caara settings layer for tests and internal harnesses. */
export const caaraSettingsDefaultLayer = caaraSettingsLayerFromValue({
  settings: defaultCaaraSettingsValue,
});
