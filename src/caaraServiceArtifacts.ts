import path from "node:path";

import { Effect, Match, Option, Schema } from "effect";

import { defaultCaaraConfigPath, type CaaraSettingsEnvironment } from "./caaraSettings.ts";

/** User-service platforms currently supported by Caara. */
export type CaaraServicePlatform = "darwin" | "linux";

/** Runtime mode for the current Caara process. */
export type CaaraServiceRuntime =
  | {
      readonly _tag: "Source";
      readonly executablePath: string;
    }
  | {
      readonly _tag: "Compiled";
      readonly executablePath: string;
    };

/** Environment values used by service lifecycle commands. */
export interface CaaraServiceLifecycleEnvironment
  extends CaaraSettingsEnvironment, Readonly<Record<string, string | undefined>> {
  readonly XDG_BIN_HOME?: string | undefined;
  readonly XDG_STATE_HOME?: string | undefined;
}

/** Failure while running a service lifecycle command. */
export class CaaraServiceLifecycleError extends Schema.TaggedErrorClass<CaaraServiceLifecycleError>()(
  "CaaraServiceLifecycleError",
  {
    message: Schema.String,
  },
) {}

/** Paths owned or referenced by service lifecycle commands. */
export interface CaaraServicePaths {
  readonly binDir: string;
  readonly installedBinaryPath: string;
  readonly configPath: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly receiptPath: string;
  readonly serviceId: string;
  readonly serviceFilePath: string;
}

/** Executable and argv used by a generated Caara user service file. */
export interface CaaraServiceProgram {
  readonly binaryPath: string;
  readonly args: readonly string[];
}

/** Stable launchd user service label. */
const launchdServiceId = (): string => "dev.caara";

/** Stable systemd user service unit name. */
const systemdServiceId = (): string => "caara.service";

/** Stable user service id for one service manager platform. */
const caaraServiceId = ({ platform }: { readonly platform: CaaraServicePlatform }): string =>
  Match.value(platform).pipe(
    Match.when("darwin", launchdServiceId),
    Match.when("linux", systemdServiceId),
    Match.exhaustive,
  );

/** Builds one typed lifecycle failure. */
export const caaraServiceLifecycleError = (message: string): CaaraServiceLifecycleError =>
  new CaaraServiceLifecycleError({ message });

/** Resolves HOME or fails explicitly. */
const resolveHome = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraServiceLifecycleEnvironment;
}) {
  return yield* Option.match(Option.fromUndefinedOr(env.HOME), {
    onNone: () =>
      Effect.fail(
        caaraServiceLifecycleError("HOME is required for Caara service lifecycle commands."),
      ),
    onSome: Effect.succeed,
  });
});

/** Resolves the user-local executable directory for installed Caara binaries. */
const resolveBinDir = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraServiceLifecycleEnvironment;
}) {
  const home = yield* resolveHome({ env });
  return env.XDG_BIN_HOME ?? path.join(home, ".local", "bin");
});

/** Resolves the XDG state home for receipts, state, and purge cleanup. */
const resolveStateHome = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraServiceLifecycleEnvironment;
}) {
  const home = yield* resolveHome({ env });
  return env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
});

/** Resolves the XDG config home for service config and systemd units. */
const resolveConfigHome = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraServiceLifecycleEnvironment;
}) {
  const home = yield* resolveHome({ env });
  return env.XDG_CONFIG_HOME ?? path.join(home, ".config");
});

/** Resolves service lifecycle paths for one platform. */
export const resolveServicePaths = Effect.fnUntraced(function* ({
  env,
  platform,
}: {
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly platform: CaaraServicePlatform;
}) {
  const home = yield* resolveHome({ env });
  const binDir = yield* resolveBinDir({ env });
  const configHome = yield* resolveConfigHome({ env });
  const stateHome = yield* resolveStateHome({ env });
  const configPath = defaultCaaraConfigPath({ env });
  const stateDir = path.join(stateHome, "caara");
  const serviceId = caaraServiceId({ platform });
  const serviceFilePath = Match.value(platform).pipe(
    Match.when("darwin", () => path.join(home, "Library", "LaunchAgents", `${serviceId}.plist`)),
    Match.when("linux", () => path.join(configHome, "systemd", "user", serviceId)),
    Match.exhaustive,
  );

  return {
    binDir,
    installedBinaryPath: path.join(binDir, "caara"),
    configPath,
    configDir: path.dirname(configPath),
    stateDir,
    receiptPath: path.join(stateDir, "install-receipt.json"),
    serviceId,
    serviceFilePath,
  } satisfies CaaraServicePaths;
});

/** Escapes text for XML plist content. */
const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Renders the launchd user agent plist for Caara. */
export const renderLaunchdPlist = ({
  program,
  serviceId,
}: {
  readonly program: CaaraServiceProgram;
  readonly serviceId: string;
}): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(serviceId)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[program.binaryPath, ...program.args].map(
      (argument) => `    <string>${xmlEscape(argument)}</string>`,
    ),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>CAARA_SERVICE</key>",
    "    <string>1</string>",
    "  </dict>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

/** Escapes one systemd ExecStart argument without invoking a shell. */
const systemdExecStartArgument = (argument: string): string => {
  const escaped = argument
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");
  return Match.value(/[\s"\\$`]/u.test(argument)).pipe(
    Match.when(true, () => `"${escaped}"`),
    Match.orElse(() => escaped),
  );
};

/** Renders the systemd user unit for Caara. */
export const renderSystemdUserUnit = ({
  program,
}: {
  readonly program: CaaraServiceProgram;
}): string => {
  const execStart = [program.binaryPath, ...program.args].map(systemdExecStartArgument).join(" ");
  return [
    "[Unit]",
    "Description=Caara Responses API service",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Environment=CAARA_SERVICE=1",
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
};

/** Renders the platform-specific service manager file content. */
export const renderServiceFile = ({
  platform,
  program,
  serviceId,
}: {
  readonly platform: CaaraServicePlatform;
  readonly program: CaaraServiceProgram;
  readonly serviceId: string;
}): string =>
  Match.value(platform).pipe(
    Match.when("darwin", () => renderLaunchdPlist({ program, serviceId })),
    Match.when("linux", () => renderSystemdUserUnit({ program })),
    Match.exhaustive,
  );
