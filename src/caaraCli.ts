import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Match, Option, Record } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import packageMetadata from "../package.json" with { type: "json" };
import {
  runCaaraInstallAntigravityGuidanceCli,
  runCaaraUninstallAntigravityGuidanceCli,
} from "./antigravityPortableGuidance.ts";
import {
  CaaraAgentCliError,
  type CaaraAgentPromptSource,
  type CaaraAgentPromptReader,
  liveCaaraAgentPromptReader,
  runCaaraAgentInputErrorCli,
  resolveCaaraAgentPrompt,
  runCaaraAgentCancelCli,
  runCaaraAgentStartCli,
  runCaaraAgentWaitCli,
} from "./caaraAgentCli.ts";
import { mainLayerFromArgs } from "./caaraApp.ts";
import { runCaaraDoctorCli } from "./caaraDoctor.ts";
import { runCaaraInstallServiceCli, runCaaraUninstallServiceCli } from "./caaraServiceLifecycle.ts";
import { runCaaraStatusCli } from "./caaraStatus.ts";
import {
  runCaaraInstallClaudeGuidanceCli,
  runCaaraUninstallClaudeGuidanceCli,
} from "./claudePortableGuidance.ts";
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

/** Selects exactly one safe prompt source from the public start flags. */
const selectPromptSource = ({
  prompt,
  promptFile,
  stdin,
}: {
  readonly prompt: Option.Option<string>;
  readonly promptFile: Option.Option<string>;
  readonly stdin: boolean;
}) => {
  const sources: CaaraAgentPromptSource[] = [
    ...Option.toArray(prompt).map((value) => ({ _tag: "Direct", value }) as const),
    ...Option.toArray(promptFile).map((path) => ({ _tag: "File", path }) as const),
    ...[{ _tag: "Stdin" } as const].filter(() => stdin),
  ];
  const source = sources.at(0);
  return Match.value(sources.length === 1 && source !== undefined).pipe(
    Match.when(true, () => Effect.succeed(source as CaaraAgentPromptSource)),
    Match.orElse(() =>
      Effect.fail(
        new CaaraAgentCliError({
          kind: "invalid_request",
          message: "Specify exactly one of --prompt, --prompt-file, or --stdin.",
        }),
      ),
    ),
  );
};

/** Parses repeated driver-owned options while rejecting malformed and duplicate names. */
const parseDriverOptions = (values: readonly string[]) => {
  const entries = values.map((value) => {
    const separator = value.indexOf("=");
    const name = value.slice(0, Math.max(separator, 0));
    return { name, value: value.slice(separator + 1), valid: separator >= 1 };
  });
  const names = new Set(entries.map(({ name }) => name));
  return Match.value(entries.every(({ valid }) => valid) && names.size === entries.length).pipe(
    Match.when(true, () =>
      Effect.succeed(Record.fromIterableWith(entries, ({ name, value }) => [name, value])),
    ),
    Match.orElse(() =>
      Effect.fail(
        new CaaraAgentCliError({
          kind: "invalid_request",
          message: "Invalid or duplicate --option.",
        }),
      ),
    ),
  );
};

/** Requires one non-empty public start flag through the typed error contract. */
const requireStartFlag = ({
  name,
  value,
}: {
  readonly name: string;
  readonly value: Option.Option<string>;
}) =>
  Option.match(value, {
    onNone: () =>
      Effect.fail(
        new CaaraAgentCliError({
          kind: "invalid_request",
          message: `Missing required --${name}.`,
        }),
      ),
    onSome: Effect.succeed,
  });

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
  readonly installClaudeGuidance: { readonly run: typeof runCaaraInstallClaudeGuidanceCli };
  readonly uninstallClaudeGuidance: { readonly run: typeof runCaaraUninstallClaudeGuidanceCli };
  readonly installAntigravityGuidance: {
    readonly run: typeof runCaaraInstallAntigravityGuidanceCli;
  };
  readonly uninstallAntigravityGuidance: {
    readonly run: typeof runCaaraUninstallAntigravityGuidanceCli;
  };
  readonly agentStart: { readonly run: typeof runCaaraAgentStartCli };
  readonly agentWait: { readonly run: typeof runCaaraAgentWaitCli };
  readonly agentCancel: { readonly run: typeof runCaaraAgentCancelCli };
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
  installClaudeGuidance: { run: runCaaraInstallClaudeGuidanceCli },
  uninstallClaudeGuidance: { run: runCaaraUninstallClaudeGuidanceCli },
  installAntigravityGuidance: { run: runCaaraInstallAntigravityGuidanceCli },
  uninstallAntigravityGuidance: { run: runCaaraUninstallAntigravityGuidanceCli },
  agentStart: { run: runCaaraAgentStartCli },
  agentWait: { run: runCaaraAgentWaitCli },
  agentCancel: { run: runCaaraAgentCancelCli },
};

/** Builds the public command tree around injectable typed-to-domain handler seams. */
export const createCaaraCommand = ({
  handlers,
  promptReader = liveCaaraAgentPromptReader,
}: {
  readonly handlers: CaaraCliHandlers;
  readonly promptReader?: CaaraAgentPromptReader;
}) => {
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

  /** Installs the auto-discoverable personal Claude portable-guidance skill. */
  const installClaudeGuidanceCommand = Command.make("install-claude-guidance", {}, () =>
    handlers.installClaudeGuidance.run({ args: [] }),
  ).pipe(Command.withDescription("Install Caara portable guidance for Claude"));

  /** Removes only Caara's marker-owned personal Claude portable-guidance skill. */
  const uninstallClaudeGuidanceCommand = Command.make("uninstall-claude-guidance", {}, () =>
    handlers.uninstallClaudeGuidance.run({ args: [] }),
  ).pipe(Command.withDescription("Remove Caara portable guidance for Claude"));

  /** Installs the managed block in Antigravity's global rules. */
  const installAntigravityGuidanceCommand = Command.make("install-antigravity-guidance", {}, () =>
    handlers.installAntigravityGuidance.run({ args: [] }),
  ).pipe(Command.withDescription("Install Caara portable guidance for Antigravity"));

  /** Removes only Caara's managed block from Antigravity's global rules. */
  const uninstallAntigravityGuidanceCommand = Command.make(
    "uninstall-antigravity-guidance",
    {},
    () => handlers.uninstallAntigravityGuidance.run({ args: [] }),
  ).pipe(Command.withDescription("Remove Caara portable guidance for Antigravity"));

  /** Safely submits one prompt value without transcript or stdin ambiguity. */
  const agentStartCommand = Command.make(
    "start",
    {
      ...settingsFlags(),
      target: Flag.optional(
        Flag.string("target").pipe(Flag.withDescription("Agent target in kind/model form")),
      ),
      cwd: Flag.optional(
        Flag.string("cwd").pipe(Flag.withDescription("Existing Agent working directory")),
      ),
      prompt: Flag.optional(
        Flag.string("prompt").pipe(Flag.withDescription("Prompt value supplied directly")),
      ),
      promptFile: Flag.optional(
        Flag.string("prompt-file").pipe(Flag.withDescription("Read the prompt from this file")),
      ),
      stdin: Flag.boolean("stdin").pipe(Flag.withDescription("Read the prompt from stdin")),
      driverOptions: Flag.string("option").pipe(
        Flag.between(0, 100),
        Flag.withDescription("Driver-owned option as name=value; repeat for multiple options"),
      ),
      json: Flag.boolean("json").pipe(Flag.withDescription("Print stable JSON output")),
      sessionId: Flag.optional(
        Flag.string("session-id").pipe(
          Flag.withDescription("Resume the selected portable Agent session"),
        ),
      ),
    },
    (input) =>
      Effect.gen(function* () {
        const source = yield* selectPromptSource(input);
        const prompt = yield* resolveCaaraAgentPrompt({ source, reader: promptReader });
        const target = yield* requireStartFlag({ name: "target", value: input.target });
        const cwd = yield* requireStartFlag({ name: "cwd", value: input.cwd });
        const driverOptions = yield* parseDriverOptions(input.driverOptions);
        return yield* handlers.agentStart.run({
          args: settingsArgs(input),
          prompt,
          target,
          cwd,
          driverOptions,
          sessionId: Option.getOrUndefined(input.sessionId),
          json: input.json,
        });
      }).pipe(
        Effect.catchTag("CaaraAgentCliError", (error) =>
          runCaaraAgentInputErrorCli({ error, json: input.json }),
        ),
      ),
  ).pipe(Command.withDescription("Start one portable diagnostic Agent turn"));

  /** Reads an Agent-safe coarse or final result for one accepted turn. */
  const agentWaitCommand = Command.make(
    "wait",
    {
      ...settingsFlags(),
      turnId: Argument.string("turn-id").pipe(Argument.withDescription("Portable turn ID")),
      timeoutMillis: Flag.optional(
        Flag.integer("timeout-millis").pipe(
          Flag.withDescription("Maximum milliseconds to wait without cancelling the turn"),
        ),
      ),
      json: Flag.boolean("json").pipe(Flag.withDescription("Print stable JSON output")),
    },
    (input) =>
      handlers.agentWait.run({
        args: settingsArgs(input),
        turnId: input.turnId,
        timeoutMillis: Option.getOrUndefined(input.timeoutMillis),
        json: input.json,
      }),
  ).pipe(Command.withDescription("Read one portable Agent turn result"));

  /** Cancels one working portable Agent turn. */
  const agentCancelCommand = Command.make(
    "cancel",
    {
      ...settingsFlags(),
      turnId: Argument.string("turn-id").pipe(Argument.withDescription("Portable turn ID")),
      json: Flag.boolean("json").pipe(Flag.withDescription("Print stable JSON output")),
    },
    (input) =>
      handlers.agentCancel.run({
        args: settingsArgs(input),
        turnId: input.turnId,
        json: input.json,
      }),
  ).pipe(Command.withDescription("Cancel one portable Agent turn"));

  /** Groups portable Agent commands under one stable namespace. */
  const agentCommand = Command.make("agent").pipe(
    Command.withDescription("Delegate portable Agent turns"),
    Command.withSubcommands([agentStartCommand, agentWaitCommand, agentCancelCommand]),
  );

  return serverCommand.pipe(
    Command.withSubcommands([
      statusCommand,
      doctorCommand,
      installServiceCommand,
      uninstallServiceCommand,
      installCodexRolesCommand,
      uninstallCodexRolesCommand,
      installClaudeGuidanceCommand,
      uninstallClaudeGuidanceCommand,
      installAntigravityGuidanceCommand,
      uninstallAntigravityGuidanceCommand,
      agentCommand,
    ]),
  );
};

/** Complete public Caara CLI command tree. */
export const caaraCommand = createCaaraCommand({ handlers: liveCaaraCliHandlers });

/** Detects raw portable command syntax failures before the CLI framework prints help text. */
const agentCliSyntaxError = (args: readonly string[]): Option.Option<string> => {
  const command = args.at(1);
  const tail = args.slice(2);
  const commonValueFlags = ["--config", "--host", "--port", "--log-level"];
  const valueFlags: readonly string[] = Match.value(command).pipe(
    Match.when("start", () => [
      ...commonValueFlags,
      "--target",
      "--cwd",
      "--prompt",
      "--prompt-file",
      "--option",
      "--session-id",
    ]),
    Match.when("wait", () => [...commonValueFlags, "--timeout-millis"]),
    Match.when("cancel", () => commonValueFlags),
    Match.orElse(() => []),
  );
  const booleanFlags: readonly string[] = Match.value(command).pipe(
    Match.when("start", () => ["--stdin", "--json", "--allow-dangerous-skip-permissions"]),
    Match.when("wait", () => ["--json", "--allow-dangerous-skip-permissions"]),
    Match.when("cancel", () => ["--json", "--allow-dangerous-skip-permissions"]),
    Match.orElse(() => []),
  );
  const allowedFlags = new Set([...valueFlags, ...booleanFlags]);
  const unknownFlag = tail.find(
    (token) => token.startsWith("--") && !allowedFlags.has(token.split("=", 1)[0] ?? token),
  );
  const missingValueFlag = tail.find(
    (token, index) =>
      valueFlags.includes(token) &&
      (tail.at(index + 1) === undefined || tail.at(index + 1)?.startsWith("--") === true),
  );
  const consumedValueIndices = new Set(
    tail.flatMap((token, index) => [index + 1].filter(() => valueFlags.includes(token))),
  );
  const positional = tail.filter(
    (token, index) => !token.startsWith("--") && !consumedValueIndices.has(index),
  );
  const invalidPositionalCount =
    (command === "wait" || command === "cancel") && positional.length !== 1;
  const timeoutIndex = tail.indexOf("--timeout-millis");
  const timeout = Option.fromUndefinedOr(tail.at(timeoutIndex + 1)).pipe(
    Option.filter(() => timeoutIndex >= 0),
    Option.map(Number),
  );
  const errors = [
    Option.fromUndefinedOr(
      [`Unknown caara agent command: ${command ?? "missing"}.`]
        .filter(() => !["start", "wait", "cancel"].includes(command ?? ""))
        .at(0),
    ),
    Option.map(Option.fromUndefinedOr(unknownFlag), (flag) => `Unknown caara agent flag: ${flag}.`),
    Option.map(
      Option.fromUndefinedOr(missingValueFlag),
      (flag) => `Missing value for caara agent flag: ${flag}.`,
    ),
    Option.fromUndefinedOr(
      [`Missing or duplicate ${command} turn ID.`].filter(() => invalidPositionalCount).at(0),
    ),
    Option.fromUndefinedOr(
      ["Invalid --timeout-millis integer."]
        .filter(() => Option.exists(timeout, (value) => !Number.isSafeInteger(value)))
        .at(0),
    ),
  ];
  const globalAction = args.some((token) =>
    ["--help", "-h", "--version", "-v", "--completions"].includes(token),
  );
  return Match.value({ globalAction, root: args.at(0) }).pipe(
    Match.when({ globalAction: false, root: "agent" }, () => Option.firstSomeOf(errors)),
    Match.orElse(() => Option.none()),
  );
};

/** Runs the Caara CLI through Effect's parser, global actions, and command dispatcher. */
export const caaraCliMain = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  const execution = Command.runWith(caaraCommand, { version: caaraVersion })(args).pipe(
    Effect.provide(BunServices.layer),
  );
  const recoverParserError = () =>
    runCaaraAgentInputErrorCli({
      error: new CaaraAgentCliError({
        kind: "invalid_request",
        message: "Invalid caara agent command.",
      }),
      json: args.includes("--json"),
    });
  const caughtAgentExecution = execution.pipe(Effect.catch(recoverParserError));
  const agentExecution = Option.match(agentCliSyntaxError(args), {
    onNone: () => caughtAgentExecution,
    onSome: (message) =>
      runCaaraAgentInputErrorCli({
        error: new CaaraAgentCliError({ kind: "invalid_request", message }),
        json: args.includes("--json"),
      }),
  });
  return yield* Match.value(args.at(0)).pipe(
    Match.when("agent", () => agentExecution),
    Match.orElse(() => execution),
  );
});
