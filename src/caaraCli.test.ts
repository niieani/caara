import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { TestConsole } from "effect/testing";
import { CliOutput, Command } from "effect/unstable/cli";

import packageMetadata from "../package.json" with { type: "json" };
import {
  caaraCommand,
  caaraVersion,
  createCaaraCommand,
  type CaaraCliHandlers,
} from "./caaraCli.ts";

/** Deterministic platform and output services used by Caara CLI rendering tests. */
const cliTestLayer = Layer.mergeAll(
  BunServices.layer,
  TestConsole.layer,
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
);

/** Runs the root Caara command and returns rendered standard output. */
const runCaaraCommand = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  yield* Command.runWith(caaraCommand, { version: caaraVersion })(args);
  return (yield* TestConsole.logLines).join("\n");
});

/** Builds one recording command handler for typed root dispatch tests. */
const recordingHandler = ({ name, events }: { readonly name: string; readonly events: string[] }) =>
  ({
    run: Effect.fnUntraced(function* ({ args }: { readonly args: readonly string[] }) {
      events.push(`${name}:${args.join(" ")}`);
      yield* Effect.void;
    }),
  }) satisfies CaaraCliHandlers["server"];

/** Builds a complete recording handler set for every public root command. */
const recordingHandlers = ({ events }: { readonly events: string[] }): CaaraCliHandlers => ({
  server: recordingHandler({ name: "server", events }),
  status: recordingHandler({ name: "status", events }),
  doctor: recordingHandler({ name: "doctor", events }),
  installService: recordingHandler({ name: "install-service", events }),
  uninstallService: recordingHandler({ name: "uninstall-service", events }),
  installCodexRoles: recordingHandler({ name: "install-codex-roles", events }),
  uninstallCodexRoles: recordingHandler({ name: "uninstall-codex-roles", events }),
  agentStart: {
    run: Effect.fnUntraced(function* ({ args, prompt, target, cwd, driverOptions, json }) {
      const encodedOptions = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
      )(driverOptions);
      events.push(
        `agent-start:${args.join(" ")}:${target}:${cwd}:${encodedOptions}:${String(json)}:${prompt}`,
      );
    }),
  },
  agentWait: {
    run: ({ args, turnId, json }) =>
      Effect.suspend(() => {
        events.push(`agent-wait:${args.join(" ")}:${turnId}:${String(json)}`);
        return Effect.void;
      }),
  },
  agentCancel: {
    run: ({ args, turnId, json }) =>
      Effect.suspend(() => {
        events.push(`agent-cancel:${args.join(" ")}:${turnId}:${String(json)}`);
        return Effect.void;
      }),
  },
});

describe("Caara root CLI", () => {
  it.effect("renders successful root help with every supported subcommand", () =>
    Effect.gen(function* () {
      const output = yield* runCaaraCommand({ args: ["--help"] });

      assert.match(output, /USAGE\s+caara <subcommand> \[flags\]/u);
      assert.match(output, /SUBCOMMANDS/u);
      for (const subcommand of [
        "status",
        "doctor",
        "install-service",
        "uninstall-service",
        "install-codex-roles",
        "uninstall-codex-roles",
        "agent",
      ]) {
        assert.match(output, new RegExp(`\\n  ${subcommand}`, "u"));
      }
      assert.match(output, /uninstall-codex-roles Remove Caara-managed/u);
    }).pipe(Effect.provide(cliTestLayer)),
  );

  it.effect("renders the package version without executing the server handler", () =>
    Effect.gen(function* () {
      const output = yield* runCaaraCommand({ args: ["--version"] });

      assert.strictEqual(caaraVersion, packageMetadata.version);
      assert.strictEqual(output, `caara v${caaraVersion}`);
    }).pipe(Effect.provide(cliTestLayer)),
  );

  it.effect("renders command-specific help from the same command tree", () =>
    Effect.gen(function* () {
      const output = yield* runCaaraCommand({ args: ["install-service", "--help"] });

      assert.match(output, /USAGE\s+caara install-service \[flags\]/u);
      assert.match(output, /--no-start/u);
      assert.match(output, /--no-install-codex-roles/u);
      assert.match(output, /--yolo/u);
    }).pipe(Effect.provide(cliTestLayer)),
  );

  it.effect("dispatches typed root and subcommand input through canonical argv boundaries", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const command = createCaaraCommand({ handlers: recordingHandlers({ events }) });
      const run = Command.runWith(command, { version: caaraVersion });

      yield* run(["--config", "/tmp/caara.yaml", "--no-allow-dangerous-skip-permissions"]);
      yield* run(["status", "--port", "8799"]);
      yield* run(["doctor", "--config", "/tmp/caara.yaml", "--fix"]);
      yield* run([
        "install-service",
        "--host",
        "127.0.0.2",
        "--no-start",
        "--no-install-codex-roles",
        "--yolo",
      ]);
      yield* run(["uninstall-service", "--purge"]);
      yield* run([
        "install-codex-roles",
        "--config",
        "/tmp/caara.yaml",
        "--agents-md",
        "--panel-skill",
        "--yolo",
        "/tmp/agents",
      ]);
      yield* run(["uninstall-codex-roles", "/tmp/agents"]);
      yield* run([
        "agent",
        "start",
        "--port",
        "8799",
        "--target",
        "diagnostic/activity",
        "--cwd",
        "/tmp",
        "--option",
        "alpha=β",
        "--json",
        "--prompt",
        "safe prompt",
      ]);
      yield* run(["agent", "wait", "--port", "8799", "turn-1"]);

      assert.deepStrictEqual(events, [
        "server:--config /tmp/caara.yaml --no-allow-dangerous-skip-permissions",
        "status:--port 8799",
        "doctor:--config /tmp/caara.yaml --fix",
        "install-service:--host 127.0.0.2 --no-install-codex-roles --no-start --yolo",
        "uninstall-service:--purge",
        "install-codex-roles:--config /tmp/caara.yaml --agents-md --panel-skill --yolo /tmp/agents",
        "uninstall-codex-roles:/tmp/agents",
        'agent-start:--port 8799:diagnostic/activity:/tmp:{"alpha":"β"}:true:safe prompt',
        "agent-wait:--port 8799:turn-1:false",
      ]);
    }).pipe(Effect.provide(cliTestLayer)),
  );

  it.effect("handles completions and log-level help without invoking a command handler", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const command = createCaaraCommand({ handlers: recordingHandlers({ events }) });
      const run = Command.runWith(command, { version: caaraVersion });

      yield* run(["--completions", "zsh"]);
      yield* run(["--log-level", "warning", "--help"]);
      const output = (yield* TestConsole.logLines).join("\n");

      assert.deepStrictEqual(events, []);
      assert.match(output, /#compdef caara/u);
      assert.match(output, /SUBCOMMANDS/u);
    }).pipe(Effect.provide(cliTestLayer)),
  );

  it.effect("parses exactly one direct, file, or stdin prompt without changing its text", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const promptFixtures = {
        file: "file\nλ $()",
        stdin: "stdin\nλ $()",
      } as const;
      const command = createCaaraCommand({
        handlers: recordingHandlers({ events }),
        promptReader: {
          file: () => Effect.succeed(promptFixtures.file),
          stdin: Effect.succeed(promptFixtures.stdin),
        },
      });
      const run = Command.runWith(command, { version: caaraVersion });
      const prefix = ["agent", "start", "--target", "diagnostic/activity", "--cwd", "/tmp"];
      yield* run([...prefix, "--prompt", "direct\nλ $()"]);
      yield* run([...prefix, "--prompt-file", "/prompt.txt"]);
      yield* run([...prefix, "--stdin"]);

      assert.deepStrictEqual(
        events.map((event) => event.slice(event.lastIndexOf(":") + 1)),
        ["direct\nλ $()", "file\nλ $()", "stdin\nλ $()"],
      );
    }).pipe(Effect.provide(cliTestLayer)),
  );

  it.effect("rejects missing, conflicting prompt forms and duplicate driver options", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const run = Command.runWith(createCaaraCommand({ handlers: recordingHandlers({ events }) }), {
        version: caaraVersion,
      });
      const prefix = ["agent", "start", "--target", "diagnostic/activity", "--cwd", "/tmp"];
      const priorExitCode = process.exitCode;
      for (const suffix of [
        [],
        ["--prompt", "one", "--stdin"],
        ["--prompt", "one", "--option", "mode=a", "--option", "mode=b"],
        ["--prompt", "one", "--option", "malformed"],
      ]) {
        process.exitCode = undefined;
        assert.strictEqual((yield* Effect.result(run([...prefix, ...suffix])))._tag, "Success");
        assert.strictEqual(process.exitCode, 64);
      }
      process.exitCode = priorExitCode;
      assert.deepStrictEqual(events, []);
      assert.match((yield* TestConsole.errorLines).join("\n"), /invalid|requires|option/iu);
    }).pipe(Effect.provide(cliTestLayer)),
  );
});
