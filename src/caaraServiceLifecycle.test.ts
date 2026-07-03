import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import type { CaaraDoctorResult } from "./caaraDoctor.ts";
import {
  runCaaraInstallService,
  runCaaraUninstallService,
  type CaaraServiceDoctor,
  type CaaraServiceManager,
} from "./caaraServiceLifecycle.ts";
import { serviceManagerStartCommands } from "./caaraServiceManager.ts";
import { parseCaaraServiceConfigYaml } from "./caaraSettings.ts";
import { CaaraStatusError, type CaaraHealthProbe } from "./caaraStatus.ts";

/** Builds one isolated service lifecycle test root under temp.local. */
const testRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-06-29", `caara-service-${randomUUID()}`);

/** Writes one UTF-8 file, creating its parent directory first. */
const writeFile = Effect.fnUntraced(function* ({
  filePath,
  content,
}: {
  readonly filePath: string;
  readonly content: string;
}) {
  yield* Effect.tryPromise(() => fs.mkdir(path.dirname(filePath), { recursive: true }));
  yield* Effect.tryPromise(() => fs.writeFile(filePath, content, "utf8"));
});

/** Reads one UTF-8 file. */
const readFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
});

/** Returns whether one file exists. */
const fileExists = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => Bun.file(filePath).exists());
});

/** Builds a stable service lifecycle test environment. */
const serviceEnv = ({ root }: { readonly root: string }) =>
  ({
    HOME: path.join(root, "home"),
    XDG_BIN_HOME: path.join(root, "xdg-bin"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  }) as const;

/** Compiled-runtime fixture used by install-service tests. */
const compiledRuntime = ({ executablePath }: { readonly executablePath: string }) =>
  ({
    _tag: "Compiled",
    executablePath,
  }) as const;

/** Source-runtime fixture used by install-service tests. */
const sourceRuntime = ({ executablePath }: { readonly executablePath: string }) =>
  ({
    _tag: "Source",
    executablePath,
  }) as const;

/** Fake service manager recording unload attempts without touching launchd/systemd. */
const recordingServiceManager = (events: string[]): CaaraServiceManager => ({
  start: Effect.fnUntraced(function* ({ serviceFilePath, serviceId }) {
    events.push(`start:${serviceId}:${serviceFilePath}`);
    yield* Effect.void;
  }),
  statusHint: ({ serviceId }) => `status ${serviceId}`,
  unload: Effect.fnUntraced(function* ({ serviceId, serviceFilePath }) {
    events.push(`unload:${serviceId}:${serviceFilePath}`);
    yield* Effect.void;
  }),
});

/** Original config fixture used to prove install-service preservation semantics. */
const originalConfigFixture = (): string => "host: 127.0.0.2\nport: 8788\n";

/** Builds one successful doctor result for service start tests. */
const doctorOkResult = ({ configPath }: { readonly configPath: string }): CaaraDoctorResult => ({
  exitCode: 0,
  message: "Caara doctor ok",
  checks: [],
  appendedPathEntries: [],
  configUpdated: false,
  configPath,
});

/** Builds a doctor seam that records each repair attempt. */
const recordingDoctor = ({
  events,
  result,
}: {
  readonly events: string[];
  readonly result: CaaraDoctorResult;
}): CaaraServiceDoctor => ({
  fix: ({ args }) =>
    Effect.gen(function* () {
      events.push(`doctor:${args.join(" ")}`);
      yield* Effect.void;
      return result;
    }),
});

/** Builds a health probe seam that records each probed URL. */
const recordingHealthProbe = ({ events }: { readonly events: string[] }): CaaraHealthProbe => ({
  probe: (url) =>
    Effect.gen(function* () {
      events.push(`health:${url}`);
      yield* Effect.void;
      return { status: "ok", service: "caara" } as const;
    }),
});

/** Builds a health probe that records attempts and always fails. */
const failingHealthProbe = ({ attempts }: { readonly attempts: string[] }): CaaraHealthProbe => ({
  probe: Effect.fnUntraced(function* (url) {
    attempts.push(url);
    return yield* new CaaraStatusError({ message: "connection refused" });
  }),
});

describe("Caara service lifecycle", () => {
  it.effect("fails install-service --no-start from source mode with build guidance", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const result = yield* runCaaraInstallService({
        args: ["--no-start"],
        env: serviceEnv({ root }),
        platform: "darwin",
        runtime: sourceRuntime({ executablePath: path.join(root, "src", "caara.ts") }),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /bun run build:service/u);
      assert.match(result.message, /dist\/caara install-service/u);
    }),
  );

  it.effect("installs a compiled binary and launchd unit without starting it", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const sourceExecutable = path.join(root, "dist", "caara-source");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: ["--no-start"],
        env,
        platform: "darwin",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const installedBinary = path.join(env.XDG_BIN_HOME, "caara");
      const serviceFile = path.join(env.HOME, "Library", "LaunchAgents", "dev.caara.plist");
      const receiptPath = path.join(env.XDG_STATE_HOME, "caara", "install-receipt.json");

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.message, /config created/u);
      assert.strictEqual(yield* readFile({ filePath: installedBinary }), "compiled-caara");
      assert.match(yield* readFile({ filePath: serviceFile }), new RegExp(installedBinary, "u"));
      assert.match(yield* readFile({ filePath: serviceFile }), /CAARA_SERVICE/u);
      assert.match(yield* readFile({ filePath: receiptPath }), /dev\.caara/u);
      assert.match(yield* readFile({ filePath: receiptPath }), new RegExp(installedBinary, "u"));
    }),
  );

  it.effect("writes a systemd user unit pointing at the installed binary", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const sourceExecutable = path.join(root, "dist", "caara-source");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      yield* runCaaraInstallService({
        args: ["--no-start"],
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const installedBinary = path.join(env.XDG_BIN_HOME, "caara");
      const serviceFile = path.join(env.XDG_CONFIG_HOME, "systemd", "user", "caara.service");
      const serviceUnit = yield* readFile({ filePath: serviceFile });

      assert.match(serviceUnit, new RegExp(`ExecStart=${installedBinary}`, "u"));
      assert.match(serviceUnit, /Environment=CAARA_SERVICE=1/u);
    }),
  );

  it.effect("installs service artifacts against an explicit durable config path", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const explicitConfigPath = path.join(root, "custom config", "caara.yaml");
      const relativeConfigPath = path.relative(process.cwd(), explicitConfigPath);
      const defaultConfigPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      const serviceFile = path.join(env.XDG_CONFIG_HOME, "systemd", "user", "caara.service");
      const receiptPath = path.join(env.XDG_STATE_HOME, "caara", "install-receipt.json");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });
      yield* writeFile({ filePath: explicitConfigPath, content: "port: 8787\n" });

      const result = yield* runCaaraInstallService({
        args: ["--no-start", "--config", relativeConfigPath, "--port", "8798"],
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const config = yield* parseCaaraServiceConfigYaml({
        yaml: yield* readFile({ filePath: explicitConfigPath }),
      });
      const serviceUnit = yield* readFile({ filePath: serviceFile });
      const receipt = yield* readFile({ filePath: receiptPath });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(config.port, 8798);
      assert.strictEqual(yield* fileExists({ filePath: defaultConfigPath }), false);
      assert.match(serviceUnit, /ExecStart=.* --config /u);
      assert.match(serviceUnit, /"[^"]*custom config\/caara\.yaml"/u);
      assert.ok(receipt.includes(`"configPath":"${explicitConfigPath}"`));
      assert.ok(!receipt.includes(`"configPath":"${relativeConfigPath}"`));
    }),
  );

  it.effect("preserves existing config unless install flags update specific keys", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });
      yield* writeFile({ filePath: configPath, content: originalConfigFixture() });

      const preserved = yield* runCaaraInstallService({
        args: ["--no-start"],
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const preservedConfig = yield* readFile({ filePath: configPath });

      const updated = yield* runCaaraInstallService({
        args: ["--no-start", "--port", "8799"],
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const updatedConfig = yield* parseCaaraServiceConfigYaml({
        yaml: yield* readFile({ filePath: configPath }),
      });

      assert.match(preserved.message, /config preserved/u);
      assert.strictEqual(preservedConfig, originalConfigFixture());
      assert.match(updated.message, /config updated/u);
      assert.strictEqual(updatedConfig.host, "127.0.0.2");
      assert.strictEqual(updatedConfig.port, 8799);
    }),
  );

  it.effect("uninstalls receipt-owned service artifacts and supports purge", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const managerEvents: string[] = [];
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });
      yield* runCaaraInstallService({
        args: ["--no-start"],
        env,
        platform: "darwin",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const installedBinary = path.join(env.XDG_BIN_HOME, "caara");
      const serviceFile = path.join(env.HOME, "Library", "LaunchAgents", "dev.caara.plist");
      const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      const receiptPath = path.join(env.XDG_STATE_HOME, "caara", "install-receipt.json");

      const result = yield* runCaaraUninstallService({
        args: [],
        env,
        serviceManager: recordingServiceManager(managerEvents),
      });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(yield* fileExists({ filePath: installedBinary }), false);
      assert.strictEqual(yield* fileExists({ filePath: serviceFile }), false);
      assert.strictEqual(yield* fileExists({ filePath: receiptPath }), false);
      assert.strictEqual(yield* fileExists({ filePath: configPath }), true);
      assert.match(managerEvents.at(0) ?? "", /unload:dev\.caara/u);

      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });
      yield* runCaaraInstallService({
        args: ["--no-start"],
        env,
        platform: "darwin",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const purgeResult = yield* runCaaraUninstallService({
        args: ["--purge"],
        env,
        serviceManager: recordingServiceManager(managerEvents),
      });

      assert.strictEqual(purgeResult.exitCode, 0);
      assert.strictEqual(yield* fileExists({ filePath: path.dirname(configPath) }), false);
      assert.strictEqual(
        yield* fileExists({ filePath: path.join(env.XDG_STATE_HOME, "caara") }),
        false,
      );
    }),
  );

  it.effect("starts the installed service after doctor repair and health verification", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      const serviceFile = path.join(env.HOME, "Library", "LaunchAgents", "dev.caara.plist");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: ["--host", "0.0.0.0", "--port", "8799"],
        doctor: recordingDoctor({ events, result: doctorOkResult({ configPath }) }),
        env,
        healthProbe: recordingHealthProbe({ events }),
        platform: "darwin",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
        serviceManager: recordingServiceManager(events),
      });

      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(events, [
        "doctor:--fix --host 0.0.0.0 --port 8799",
        `start:dev.caara:${serviceFile}`,
        "health:http://127.0.0.1:8799/health",
      ]);
      assert.match(result.message, /service started/u);
      assert.match(result.message, /Caara healthy/u);
    }),
  );

  it.effect(
    "starts when doctor reports one real driver plus optional missing driver warnings",
    () =>
      Effect.gen(function* () {
        const root = testRoot();
        const env = serviceEnv({ root });
        const events: string[] = [];
        const sourceExecutable = path.join(root, "dist", "caara-source");
        const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
        const serviceFile = path.join(env.XDG_CONFIG_HOME, "systemd", "user", "caara.service");
        yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

        const result = yield* runCaaraInstallService({
          args: [],
          doctor: recordingDoctor({
            events,
            result: {
              ...doctorOkResult({ configPath }),
              message:
                "Caara doctor ok with optional driver warnings\nok Claude (claude) requires claude: /tmp/claude\nwarning optional driver missing Antigravity (agy) requires agy",
            },
          }),
          env,
          healthProbe: recordingHealthProbe({ events }),
          platform: "linux",
          runtime: compiledRuntime({ executablePath: sourceExecutable }),
          serviceManager: recordingServiceManager(events),
        });

        assert.strictEqual(result.exitCode, 0);
        assert.deepStrictEqual(events, [
          "doctor:--fix",
          `start:caara.service:${serviceFile}`,
          "health:http://127.0.0.1:8787/health",
        ]);
        assert.match(result.message, /optional driver warnings/u);
        assert.match(result.message, /service started/u);
      }),
  );

  it.effect("does not run doctor, start, or health verification for --no-start", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const sourceExecutable = path.join(root, "dist", "caara-source");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: ["--no-start"],
        doctor: recordingDoctor({
          events,
          result: doctorOkResult({ configPath: path.join(root, "unused.yaml") }),
        }),
        env,
        healthProbe: recordingHealthProbe({ events }),
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
        serviceManager: recordingServiceManager(events),
      });

      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(events, []);
      assert.match(result.message, /--no-start complete/u);
    }),
  );

  it.effect("fails before service start when doctor repair leaves missing executables", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: [],
        doctor: recordingDoctor({
          events,
          result: {
            ...doctorOkResult({ configPath }),
            exitCode: 1,
            message:
              "Caara doctor found no real external driver executables\nmissing Claude requires claude\nmissing Antigravity requires agy",
          },
        }),
        env,
        healthProbe: recordingHealthProbe({ events }),
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
        serviceManager: recordingServiceManager(events),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.deepStrictEqual(events, ["doctor:--fix"]);
      assert.match(result.message, /no real external driver/u);
      assert.match(result.message, /missing Claude/u);
    }),
  );

  it.effect(
    "reports health timeout with the last health error and status hint",
    () =>
      Effect.gen(function* () {
        const root = testRoot();
        const env = serviceEnv({ root });
        const events: string[] = [];
        const healthAttempts: string[] = [];
        const sourceExecutable = path.join(root, "dist", "caara-source");
        const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
        yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

        const result = yield* runCaaraInstallService({
          args: ["--port", "8799"],
          doctor: recordingDoctor({ events, result: doctorOkResult({ configPath }) }),
          env,
          healthProbe: failingHealthProbe({ attempts: healthAttempts }),
          platform: "linux",
          runtime: compiledRuntime({ executablePath: sourceExecutable }),
          serviceManager: recordingServiceManager(events),
        }).pipe(TestClock.withLive);

        assert.strictEqual(result.exitCode, 1);
        assert.strictEqual(healthAttempts.length, 21);
        assert.match(result.message, /connection refused/u);
        assert.match(result.message, /status caara\.service/u);
      }),
    10_000,
  );

  it("selects platform-specific service start commands", () => {
    assert.deepStrictEqual(
      serviceManagerStartCommands({
        platform: "darwin",
        request: {
          serviceId: "dev.caara",
          serviceFilePath: "/Users/caara/Library/LaunchAgents/dev.caara.plist",
        },
        userId: "501",
      }),
      [
        ["launchctl", "bootstrap", "gui/501", "/Users/caara/Library/LaunchAgents/dev.caara.plist"],
        ["launchctl", "enable", "gui/501/dev.caara"],
        ["launchctl", "kickstart", "-k", "gui/501/dev.caara"],
      ],
    );
    assert.deepStrictEqual(
      serviceManagerStartCommands({
        platform: "linux",
        request: {
          serviceId: "caara.service",
          serviceFilePath: "/home/caara/.config/systemd/user/caara.service",
        },
        userId: "1000",
      }),
      [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "caara.service"],
      ],
    );
  });
});
