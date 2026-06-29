import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  runCaaraInstallService,
  runCaaraUninstallService,
  type CaaraServiceManager,
} from "./caaraServiceLifecycle.ts";
import { parseCaaraServiceConfigYaml } from "./caaraSettings.ts";

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
  unload: Effect.fnUntraced(function* ({ serviceId, serviceFilePath }) {
    events.push(`${serviceId}:${serviceFilePath}`);
    yield* Effect.void;
  }),
});

/** Original config fixture used to prove install-service preservation semantics. */
const originalConfigFixture = (): string => "host: 127.0.0.2\nport: 8788\n";

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
      const serviceFile = path.join(env.XDG_CONFIG_HOME, "systemd", "user", "dev.caara.service");
      const serviceUnit = yield* readFile({ filePath: serviceFile });

      assert.match(serviceUnit, new RegExp(`ExecStart=${installedBinary}`, "u"));
      assert.match(serviceUnit, /Environment=CAARA_SERVICE=1/u);
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
      assert.match(managerEvents.at(0) ?? "", /dev\.caara/u);

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
});
