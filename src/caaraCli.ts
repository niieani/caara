import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Match, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import packageMetadata from "../package.json" with { type: "json" };
import { mainLayerFromArgs } from "./caaraApp.ts";
import { runCaaraDoctorCli } from "./caaraDoctor.ts";
import { runCaaraInstallServiceCli, runCaaraUninstallServiceCli } from "./caaraServiceLifecycle.ts";
import { runCaaraStatusCli } from "./caaraStatus.ts";
import {
  runCaaraInstallCodexRolesCli,
  runCaaraUninstallCodexRolesCli,
} from "./codexRoleInstaller.ts";

/** Package version embedded into compiled CLI version output. */
export const caaraVersion = packageMetadata.version;

/** Parsed shared settings accepted by root, status, doctor, and service installation commands. */
interface ParsedSettingsFlags {
  readonly configPath: Option.Option<string>;
  readonly host: Option.Option<string>;
  readonly port: Option.Option<string>;
  readonly allowDangerousSkipPermissions: Option.Option<boolean>;
}

/** Shared server-setting flag definitions used by commands that resolve Caara configuration. */
const settingsFlags = () => ({
  configPath: Flag.optional(
    Flag.string("config").pipe(Flag.withDescription("Use the selected YAML configuration file")),
  ),
  host: Flag.optional(
    Flag.string("host").pipe(Flag.withDescription("Override the service bind host")),
  ),
  port: Flag.optional(
    Flag.string("port").pipe(Flag.withDescription("Override the service TCP port")),
  ),
  allowDangerousSkipPermissions: Flag.optional(
    Flag.boolean("allow-dangerous-skip-permissions").pipe(
      Flag.withDescription("Allow drivers to bypass agent permission prompts"),
    ),
  ),
});

/** Adds one optional string flag to an argv representation. */
const optionalStringFlagArgs = ({
  name,
  value,
}: {
  readonly name: string;
  readonly value: Option.Option<string>;
}): readonly string[] =>
  Option.match(value, {
    onNone: () => [],
    onSome: (selected) => [`--${name}`, selected],
  });

/** Adds one optional boolean flag, preserving explicit false through its negated spelling. */
const optionalBooleanFlagArgs = ({
  name,
  value,
}: {
  readonly name: string;
  readonly value: Option.Option<boolean>;
}): readonly string[] =>
  Option.match(value, {
    onNone: () => [],
    onSome: (enabled) => [
      `--${Match.value(enabled).pipe(
        Match.when(true, () => ""),
        Match.orElse(() => "no-"),
      )}${name}`,
    ],
  });

/** Serializes typed shared settings into the existing domain-runner argv boundary. */
const settingsArgs = ({
  configPath,
  host,
  port,
  allowDangerousSkipPermissions,
}: ParsedSettingsFlags): readonly string[] => [
  ...optionalStringFlagArgs({ name: "config", value: configPath }),
  ...optionalStringFlagArgs({ name: "host", value: host }),
  ...optionalStringFlagArgs({ name: "port", value: port }),
  ...optionalBooleanFlagArgs({
    name: "allow-dangerous-skip-permissions",
    value: allowDangerousSkipPermissions,
  }),
];

/** Adds one enabled boolean flag to an argv representation. */
const enabledFlagArgs = ({ name, enabled }: { readonly name: string; readonly enabled: boolean }) =>
  [`--${name}`].filter(() => enabled);

/** Runs the default server behind the injectable CLI handler boundary. */
const runCaaraServerCli = ({ args }: { readonly args: readonly string[] }) =>
  Layer.launch(mainLayerFromArgs({ args })).pipe(Effect.asVoid);

/** Injectable handlers behind every public Caara root command. */
export interface CaaraCliHandlers {
  readonly server: { readonly run: typeof runCaaraServerCli };
  readonly status: { readonly run: typeof runCaaraStatusCli };
  readonly doctor: { readonly run: typeof runCaaraDoctorCli };
  readonly installService: { readonly run: typeof runCaaraInstallServiceCli };
  readonly uninstallService: { readonly run: typeof runCaaraUninstallServiceCli };
  readonly installCodexRoles: { readonly run: typeof runCaaraInstallCodexRolesCli };
  readonly uninstallCodexRoles: { readonly run: typeof runCaaraUninstallCodexRolesCli };
}

/** Live command handlers backed by Caara's application and lifecycle operations. */
const liveCaaraCliHandlers: CaaraCliHandlers = {
  server: {
    run: runCaaraServerCli,
  },
  status: { run: runCaaraStatusCli },
  doctor: { run: runCaaraDoctorCli },
  installService: { run: runCaaraInstallServiceCli },
  uninstallService: { run: runCaaraUninstallServiceCli },
  installCodexRoles: { run: runCaaraInstallCodexRolesCli },
  uninstallCodexRoles: { run: runCaaraUninstallCodexRolesCli },
};

/** Builds the public command tree around injectable typed-to-domain handler seams. */
export const createCaaraCommand = ({ handlers }: { readonly handlers: CaaraCliHandlers }) => {
  /** Runs the default Caara server from typed root settings. */
  const serverCommand = Command.make("caara", settingsFlags(), (input) =>
    handlers.server.run({ args: settingsArgs(input) }),
  ).pipe(Command.withDescription("Run Caara's OpenAI-compatible Responses API service"));

  /** Reports service health using the selected settings. */
  const statusCommand = Command.make("status", settingsFlags(), (input) =>
    handlers.status.run({ args: settingsArgs(input) }),
  ).pipe(Command.withDescription("Check whether the Caara service is healthy"));

  /** Diagnoses external-agent executable configuration and optionally repairs it. */
  const doctorCommand = Command.make(
    "doctor",
    {
      ...settingsFlags(),
      fix: Flag.boolean("fix").pipe(Flag.withDescription("Repair detected configuration problems")),
    },
    (input) =>
      handlers.doctor.run({
        args: [...settingsArgs(input), ...enabledFlagArgs({ name: "fix", enabled: input.fix })],
      }),
  ).pipe(Command.withDescription("Diagnose Caara service and driver configuration"));

  /** Installs the compiled executable, user service, and generated Codex roles. */
  const installServiceCommand = Command.make(
    "install-service",
    {
      ...settingsFlags(),
      noInstallCodexRoles: Flag.boolean("no-install-codex-roles").pipe(
        Flag.withDescription("Skip generated Codex role installation"),
      ),
      noStart: Flag.boolean("no-start").pipe(
        Flag.withDescription("Install artifacts without starting the service"),
      ),
      yolo: Flag.boolean("yolo").pipe(
        Flag.withDescription("Install dangerous permission-skipping roles and enable their gate"),
      ),
    },
    (input) =>
      handlers.installService.run({
        args: [
          ...settingsArgs(input),
          ...enabledFlagArgs({
            name: "no-install-codex-roles",
            enabled: input.noInstallCodexRoles,
          }),
          ...enabledFlagArgs({ name: "no-start", enabled: input.noStart }),
          ...enabledFlagArgs({ name: "yolo", enabled: input.yolo }),
        ],
      }),
  ).pipe(Command.withDescription("Install and start the per-user Caara service"));

  /** Removes the per-user Caara service and optionally its persisted data. */
  const uninstallServiceCommand = Command.make(
    "uninstall-service",
    {
      purge: Flag.boolean("purge").pipe(
        Flag.withDescription("Also remove Caara configuration and state"),
      ),
    },
    ({ purge }) =>
      handlers.uninstallService.run({
        args: enabledFlagArgs({ name: "purge", enabled: purge }),
      }),
  ).pipe(Command.withDescription("Stop and remove the per-user Caara service"));

  /** Installs generated Codex roles into an optional target directory. */
  const installCodexRolesCommand = Command.make(
    "install-codex-roles",
    {
      configPath: settingsFlags().configPath,
      agentsMd: Flag.boolean("agents-md").pipe(
        Flag.withDescription("Install Caara-managed Codex delegation guidance"),
      ),
      panelSkill: Flag.boolean("panel-skill").pipe(
        Flag.withDescription("Install the Caara-backed panel skill"),
      ),
      yolo: Flag.boolean("yolo").pipe(
        Flag.withDescription("Generate permission-skipping role variants"),
      ),
      targetDirectory: Argument.optional(
        Argument.string("target-directory").pipe(
          Argument.withDescription("Codex roles directory; defaults under CODEX_HOME"),
        ),
      ),
    },
    (input) =>
      handlers.installCodexRoles.run({
        args: [
          ...optionalStringFlagArgs({ name: "config", value: input.configPath }),
          ...enabledFlagArgs({ name: "agents-md", enabled: input.agentsMd }),
          ...enabledFlagArgs({ name: "panel-skill", enabled: input.panelSkill }),
          ...enabledFlagArgs({ name: "yolo", enabled: input.yolo }),
          ...Option.toArray(input.targetDirectory),
        ],
      }),
  ).pipe(Command.withDescription("Install generated Codex subagent roles"));

  /** Removes Caara-managed Codex roles from an optional target directory. */
  const uninstallCodexRolesCommand = Command.make(
    "uninstall-codex-roles",
    {
      targetDirectory: Argument.optional(
        Argument.string("target-directory").pipe(
          Argument.withDescription("Codex roles directory; defaults under CODEX_HOME"),
        ),
      ),
    },
    ({ targetDirectory }) =>
      handlers.uninstallCodexRoles.run({ args: Option.toArray(targetDirectory) }),
  ).pipe(Command.withDescription("Remove Caara-managed Codex subagent roles"));

  return serverCommand.pipe(
    Command.withSubcommands([
      statusCommand,
      doctorCommand,
      installServiceCommand,
      uninstallServiceCommand,
      installCodexRolesCommand,
      uninstallCodexRolesCommand,
    ]),
  );
};

/** Complete public Caara CLI command tree. */
export const caaraCommand = createCaaraCommand({ handlers: liveCaaraCliHandlers });

/** Runs the Caara CLI through Effect's parser, global actions, and command dispatcher. */
export const caaraCliMain = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  return yield* Command.runWith(caaraCommand, { version: caaraVersion })(args).pipe(
    Effect.provide(BunServices.layer),
  );
});
