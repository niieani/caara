import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type { CaaraDoctorResult } from "./caaraDoctor.ts";
import {
  runCaaraInstallService,
  runCaaraUninstallService,
  type CaaraServiceCodexRoles,
  type CaaraServiceDoctor,
  type CaaraServiceManager,
} from "./caaraServiceLifecycle.ts";
import type { CaaraHealthProbe } from "./caaraStatus.ts";

/** Builds one isolated service role lifecycle test root under temp.local. */
const testRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-03", `caara-service-roles-${randomUUID()}`);

/** Writes one UTF-8 fixture file, creating its parent directory first. */
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

/** Returns whether one filesystem path exists. */
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

/** Builds one successful doctor result for service start tests. */
const doctorOkResult = ({
  appendedPathEntries = [],
  configPath,
}: {
  readonly appendedPathEntries?: readonly string[];
  readonly configPath: string;
}): CaaraDoctorResult => ({
  exitCode: 0,
  message: "Caara doctor ok",
  checks: [],
  appendedPathEntries,
  configUpdated: appendedPathEntries.length > 0,
  configPath,
});

/** Builds a role lifecycle seam that records install and cleanup environments. */
const recordingCodexRoles = ({
  events,
}: {
  readonly events: string[];
}): CaaraServiceCodexRoles => ({
  install: Effect.fnUntraced(function* ({ env }) {
    const roleEnv = env ?? {};
    events.push(`install:${roleEnv.PATH ?? ""}`);
    yield* Effect.void;
    return {
      exitCode: 0,
      message: "installed test Codex roles",
      skippedDrivers: [],
      targetDirectory: path.join(roleEnv.HOME ?? "", ".codex", "agents"),
      writtenFiles: [path.join(roleEnv.HOME ?? "", ".codex", "agents", "caara-test.toml")],
    };
  }),
  uninstall: Effect.fnUntraced(function* ({ env }) {
    const roleEnv = env ?? {};
    events.push(`uninstall:${roleEnv.HOME ?? ""}`);
    yield* Effect.void;
    return {
      exitCode: 0,
      message: "removed test Codex roles",
      removedFiles: [],
      targetDirectory: path.join(roleEnv.HOME ?? "", ".codex", "agents"),
    };
  }),
});

/** Fake service manager recording lifecycle requests without touching launchd/systemd. */
const recordingServiceManager = ({
  events,
}: {
  readonly events: string[];
}): CaaraServiceManager => ({
  start: Effect.fnUntraced(function* ({ serviceId }) {
    events.push(`start:${serviceId}`);
    yield* Effect.void;
  }),
  statusHint: ({ serviceId }) => `status ${serviceId}`,
  unload: Effect.fnUntraced(function* ({ serviceId }) {
    events.push(`unload:${serviceId}`);
    yield* Effect.void;
  }),
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

/** Extracts the recorded PATH from one install event. */
const installPathFromEvents = ({ events }: { readonly events: readonly string[] }): string =>
  events.find((event) => event.startsWith("install:"))?.slice("install:".length) ?? "";

describe("Caara service Codex role lifecycle", () => {
  it.effect("installs Codex roles by default with the resolved service execution path", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const driverBin = path.join(root, "drivers");
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });
      yield* writeFile({ filePath: configPath, content: `path:\n  - ${driverBin}\n` });

      const result = yield* runCaaraInstallService({
        args: ["--no-start"],
        codexRoles: recordingCodexRoles({ events }),
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const pathEntries = installPathFromEvents({ events }).split(path.delimiter);

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(pathEntries.at(0), driverBin);
      assert.ok(pathEntries.includes(path.join(env.HOME, ".local", "bin")));
      assert.match(result.message, /installed test Codex roles/u);
    }),
  );

  it.effect("fails install-service when generated role installation fails", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const sourceExecutable = path.join(root, "dist", "caara-source");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: ["--no-start"],
        codexRoles: {
          ...recordingCodexRoles({ events }),
          install: Effect.fnUntraced(function* () {
            yield* Effect.void;
            return {
              exitCode: 1,
              message: "caara install-codex-roles refused unmarked existing Codex role",
              skippedDrivers: [],
              targetDirectory: path.join(env.HOME, ".codex", "agents"),
              writtenFiles: [],
            };
          }),
        },
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /refused unmarked existing Codex role/u);
    }),
  );

  it.effect("install-service --no-start fails when no real external driver is available", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = {
        ...serviceEnv({ root }),
        PATH: "",
      };
      const sourceExecutable = path.join(root, "dist", "caara-source");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: ["--no-start"],
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /no real external driver/u);
      assert.match(result.message, /skipped Claude/u);
      assert.match(result.message, /skipped Antigravity/u);
    }),
  );

  it.effect("install-service generated roles use the resolved service host and port", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const binDir = path.join(env.HOME, ".local", "bin");
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const rolePath = path.join(env.HOME, ".codex", "agents", "caara-claude-haiku.toml");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });
      yield* writeFile({ filePath: path.join(binDir, "claude"), content: "#!/bin/sh\n" });
      yield* Effect.tryPromise(() => fs.chmod(path.join(binDir, "claude"), 0o755));

      const result = yield* runCaaraInstallService({
        args: ["--no-start", "--host", "127.0.0.1", "--port", "8799"],
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const role = yield* Effect.tryPromise(() => fs.readFile(rolePath, "utf8"));

      assert.strictEqual(result.exitCode, 0);
      assert.match(role, /base_url = "http:\/\/127\.0\.0\.1:8799\/v1"/u);
    }),
  );

  it.effect("keeps role installation enabled for --no-start unless explicitly opted out", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const sourceExecutable = path.join(root, "dist", "caara-source");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: ["--no-start", "--no-install-codex-roles"],
        codexRoles: recordingCodexRoles({ events }),
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });

      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(events, []);
      assert.strictEqual(
        yield* fileExists({ filePath: path.join(env.XDG_BIN_HOME, "caara") }),
        true,
      );
    }),
  );

  it.effect("installs Codex roles after doctor-repaired service path before service start", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const driverBin = path.join(root, "doctor-drivers");
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: [],
        codexRoles: recordingCodexRoles({ events }),
        doctor: recordingDoctor({
          events,
          result: doctorOkResult({ appendedPathEntries: [driverBin], configPath }),
        }),
        env,
        healthProbe: recordingHealthProbe({ events }),
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
        serviceManager: recordingServiceManager({ events }),
      });
      const installPathEntries = installPathFromEvents({ events }).split(path.delimiter);

      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(
        events.map((event) => event.split(":").at(0)),
        ["doctor", "install", "start", "health"],
      );
      assert.ok(installPathEntries.includes(driverBin));
    }),
  );

  it.effect("uninstall-service cleans up installed Codex roles through the role seam", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const sourceExecutable = path.join(root, "dist", "caara-source");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });
      yield* runCaaraInstallService({
        args: ["--no-start", "--no-install-codex-roles"],
        codexRoles: recordingCodexRoles({ events }),
        env,
        platform: "darwin",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });

      const result = yield* runCaaraUninstallService({
        args: [],
        codexRoles: recordingCodexRoles({ events }),
        env,
        serviceManager: recordingServiceManager({ events }),
      });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(events.includes(`uninstall:${env.HOME}`));
      assert.match(result.message, /removed test Codex roles/u);
    }),
  );

  it.effect("install-service --yolo enables the dangerous gate and requests yolo roles", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const env = serviceEnv({ root });
      const events: string[] = [];
      const sourceExecutable = path.join(root, "dist", "caara-source");
      const configPath = path.join(env.XDG_CONFIG_HOME, "caara", "config.yaml");
      yield* writeFile({ filePath: sourceExecutable, content: "compiled-caara" });

      const result = yield* runCaaraInstallService({
        args: ["--no-start", "--yolo"],
        codexRoles: {
          ...recordingCodexRoles({ events }),
          install: Effect.fnUntraced(function* ({ args, env: roleEnv }) {
            events.push(`install-args:${args.join(" ")}`);
            events.push(`install:${roleEnv?.PATH ?? ""}`);
            yield* Effect.void;
            return {
              exitCode: 0,
              message: "installed yolo Codex roles",
              skippedDrivers: [],
              targetDirectory: path.join(roleEnv?.HOME ?? "", ".codex", "agents"),
              writtenFiles: [
                path.join(roleEnv?.HOME ?? "", ".codex", "agents", "caara-yolo-test.toml"),
              ],
            };
          }),
        },
        env,
        platform: "linux",
        runtime: compiledRuntime({ executablePath: sourceExecutable }),
      });
      const config = yield* Effect.tryPromise(() => fs.readFile(configPath, "utf8"));

      assert.strictEqual(result.exitCode, 0);
      assert.match(config, /allowDangerousSkipPermissions: true/u);
      assert.ok(events.includes(`install-args:--yolo --config ${configPath}`));
    }),
  );
});
