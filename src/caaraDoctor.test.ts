import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { runCaaraDoctor, type CaaraDoctorRequirementsRegistry } from "./caaraDoctor.ts";
import { caaraAgentDriverExecutableRequirements } from "./caaraDriverRequirements.ts";
import { parseCaaraServiceConfigYaml } from "./caaraSettings.ts";

/** Stable fake driver requirements used by doctor tests. */
const fakeRequirements: CaaraDoctorRequirementsRegistry = {
  requirements: [
    {
      driverName: "Fake",
      externalAgentKind: "fake",
      executableName: "fake-agent",
    },
  ],
};

/** Stable Claude/Agy-shaped requirements that avoid depending on host-installed tools. */
const fakeRealDriverRequirements: CaaraDoctorRequirementsRegistry = {
  requirements: [
    {
      driverName: "Claude",
      externalAgentKind: "claude",
      executableName: "fake-claude",
    },
    {
      driverName: "Antigravity",
      externalAgentKind: "agy",
      executableName: "fake-agy",
    },
  ],
};

/** Builds one isolated doctor test root under temp.local. */
const testRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-06-29", `caara-doctor-${randomUUID()}`);

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

/** Writes one executable test fixture file. */
const writeExecutable = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  yield* writeFile({ filePath, content: "#!/bin/sh\nexit 0\n" });
  yield* Effect.tryPromise(() => fs.chmod(filePath, 0o755));
});

/** Reads one UTF-8 file from disk. */
const readFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
});

/** Builds a doctor test environment for one isolated HOME and inherited PATH. */
const doctorEnv = ({
  home,
  inheritedPath = "",
}: {
  readonly home: string;
  readonly inheritedPath?: string;
}) =>
  ({
    HOME: home,
    PATH: inheritedPath,
    XDG_CONFIG_HOME: undefined,
  }) as const;

describe("Caara doctor command", () => {
  it("declares current driver executable requirements from driver-owned exports", () => {
    assert.deepStrictEqual(caaraAgentDriverExecutableRequirements, [
      {
        driverName: "Claude",
        externalAgentKind: "claude",
        executableName: "claude",
      },
      {
        driverName: "Antigravity",
        externalAgentKind: "agy",
        executableName: "agy",
      },
    ]);
  });

  it.effect("reports required executables found through the effective service path", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const configPath = path.join(root, "config", "caara.yaml");
      const executableDir = path.join(root, "configured-bin");
      yield* writeExecutable({ filePath: path.join(executableDir, "fake-agent") });
      yield* writeFile({ filePath: configPath, content: `path:\n  - ${executableDir}\n` });

      const result = yield* runCaaraDoctor({
        args: ["--config", configPath],
        env: doctorEnv({ home: path.join(root, "home"), inheritedPath: "/ignored/bin" }),
        requirementsRegistry: fakeRequirements,
      });

      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(result.appendedPathEntries, []);
      assert.match(result.message, /Fake.*fake-agent.*configured-bin/u);
    }),
  );

  it.effect("reports missing executables with searched paths and a fix hint", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const configPath = path.join(root, "config", "caara.yaml");
      const configuredDir = path.join(root, "configured-bin");
      yield* writeFile({ filePath: configPath, content: `path:\n  - ${configuredDir}\n` });

      const result = yield* runCaaraDoctor({
        args: ["--config", configPath],
        env: doctorEnv({ home: path.join(root, "home"), inheritedPath: "/shell/bin" }),
        requirementsRegistry: fakeRequirements,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /Fake/u);
      assert.match(result.message, /fake-agent/u);
      assert.match(result.message, /configured-bin/u);
      assert.match(result.message, /caara doctor --fix/u);
    }),
  );

  it.effect("finds executables from built-in service defaults without mutating config", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const home = path.join(root, "home");
      yield* writeExecutable({ filePath: path.join(home, ".local", "bin", "fake-agent") });

      const result = yield* runCaaraDoctor({
        args: [],
        env: doctorEnv({ home, inheritedPath: "/ignored/bin" }),
        requirementsRegistry: fakeRequirements,
      });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.configUpdated, false);
      assert.match(result.message, /\.local\/bin\/fake-agent/u);
    }),
  );

  it.effect("fixes config path prefixes from inherited PATH without changing existing order", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const configPath = path.join(root, "config", "caara.yaml");
      const existingDir = path.join(root, "existing-bin");
      const inheritedDir = path.join(root, "shell-bin");
      yield* writeExecutable({ filePath: path.join(inheritedDir, "fake-agent") });
      yield* writeFile({ filePath: configPath, content: `path:\n  - ${existingDir}\n` });

      const result = yield* runCaaraDoctor({
        args: ["--fix", "--config", configPath],
        env: doctorEnv({ home: path.join(root, "home"), inheritedPath: inheritedDir }),
        requirementsRegistry: fakeRequirements,
      });
      const updatedYaml = yield* readFile({ filePath: configPath });
      const updatedConfig = yield* parseCaaraServiceConfigYaml({ yaml: updatedYaml });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.configUpdated, true);
      assert.deepStrictEqual(result.appendedPathEntries, [inheritedDir]);
      assert.deepStrictEqual(updatedConfig.path, [existingDir, inheritedDir]);
    }),
  );

  for (const available of fakeRealDriverRequirements.requirements) {
    it.effect(
      `succeeds with only ${available.driverName} available and reports the missing optional driver`,
      () =>
        Effect.gen(function* () {
          const root = testRoot();
          const configPath = path.join(root, "config", "caara.yaml");
          const inheritedDir = path.join(root, "shell-bin");
          yield* writeExecutable({ filePath: path.join(inheritedDir, available.executableName) });
          yield* writeFile({ filePath: configPath, content: "path: []\n" });

          const result = yield* runCaaraDoctor({
            args: ["--fix", "--config", configPath],
            env: doctorEnv({ home: path.join(root, "home"), inheritedPath: inheritedDir }),
            requirementsRegistry: fakeRealDriverRequirements,
          });
          const updatedConfig = yield* parseCaaraServiceConfigYaml({
            yaml: yield* readFile({ filePath: configPath }),
          });

          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.configUpdated, true);
          assert.deepStrictEqual(result.appendedPathEntries, [inheritedDir]);
          assert.deepStrictEqual(updatedConfig.path, [inheritedDir]);
          assert.match(result.message, new RegExp(`ok ${available.driverName}`, "u"));
          assert.match(result.message, /warning optional driver missing/u);
          assert.match(result.message, /searched:/u);
        }),
    );
  }

  it.effect("fails clearly when no real external driver executable is available", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const configPath = path.join(root, "config", "caara.yaml");
      yield* writeFile({ filePath: configPath, content: "path: []\n" });

      const result = yield* runCaaraDoctor({
        args: ["--config", configPath],
        env: doctorEnv({ home: path.join(root, "home"), inheritedPath: "" }),
        requirementsRegistry: fakeRealDriverRequirements,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /no real external driver executables/u);
      assert.match(result.message, /missing Claude/u);
      assert.match(result.message, /missing Antigravity/u);
      assert.match(result.message, /searched:/u);
    }),
  );
});
