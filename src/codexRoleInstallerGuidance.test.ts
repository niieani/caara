import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  codexAgentsGuidanceBeginMarker,
  codexAgentsGuidanceEndMarker,
} from "./codexAgentsGuidance.ts";
import { runCaaraInstallCodexRoles, runCaaraUninstallCodexRoles } from "./codexRoleInstaller.ts";
import { panelSkillAssets } from "./panelSkillAssets.ts";

/** Builds one isolated opt-in installer test root under temp.local. */
const testRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-04", `codex-optins-${randomUUID()}`);

/** Prepared fixture layout for one opt-in installer scenario. */
interface OptInFixture {
  readonly agentsFilePath: string;
  readonly codexHome: string;
  readonly env: {
    readonly CODEX_HOME: string;
    readonly HOME: string;
    readonly PATH: string;
  };
  readonly rolesDirectory: string;
  readonly skillDirectory: string;
}

/** Creates one fixture root with a claude executable on PATH. */
const makeFixture = Effect.fnUntraced(function* () {
  const root = testRoot();
  const binDir = path.join(root, "bin");
  const claudePath = path.join(binDir, "claude");
  yield* Effect.tryPromise(() => fs.mkdir(binDir, { recursive: true }));
  yield* Effect.tryPromise(() => fs.writeFile(claudePath, "#!/bin/sh\n", "utf8"));
  yield* Effect.tryPromise(() => fs.chmod(claudePath, 0o755));
  const codexHome = path.join(root, "codex-home");
  return {
    agentsFilePath: path.join(codexHome, "AGENTS.md"),
    codexHome,
    env: {
      CODEX_HOME: codexHome,
      HOME: path.join(root, "home"),
      PATH: binDir,
    },
    rolesDirectory: path.join(codexHome, "agents"),
    skillDirectory: path.join(codexHome, "skills", "panel"),
  } satisfies OptInFixture;
});

/** Reads one UTF-8 text fixture. */
const readFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
});

/** Returns whether one fixture path exists. */
const pathExists = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() =>
    fs
      .access(filePath)
      .then(() => true)
      .catch(() => false),
  );
});

describe("Codex role installer delegation opt-ins", () => {
  it.effect("--agents-md writes the managed guidance block without a panel reference", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();

      const result = yield* runCaaraInstallCodexRoles({
        args: ["--agents-md"],
        env: fixture.env,
      });

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.message, /installed 4 Codex roles/u);
      assert.match(result.message, /updated Codex AGENTS\.md guidance/u);
      const agents = yield* readFile({ filePath: fixture.agentsFilePath });
      assert.ok(agents.includes(codexAgentsGuidanceBeginMarker()));
      assert.ok(agents.includes(codexAgentsGuidanceEndMarker()));
      assert.ok(!agents.includes("$panel"));
      assert.match(agents, /never open, fetch, inspect, or summarize/u);
      assert.match(agents, /consume\s+only `finalAnswer`/u);
      assert.ok(result.writtenFiles.includes(fixture.agentsFilePath));
      assert.strictEqual(yield* pathExists({ filePath: fixture.skillDirectory }), false);
    }),
  );

  it.effect("--panel-skill installs the global skill without touching AGENTS.md", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();

      const result = yield* runCaaraInstallCodexRoles({
        args: ["--panel-skill"],
        env: fixture.env,
      });

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.message, /installed panel skill/u);
      const skillMd = yield* readFile({
        filePath: path.join(fixture.skillDirectory, "SKILL.md"),
      });
      assert.strictEqual(skillMd, panelSkillAssets["SKILL.md"]);
      assert.strictEqual(yield* pathExists({ filePath: fixture.agentsFilePath }), false);
    }),
  );

  it.effect("--agents-md references $panel when the skill is installed in the same run", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();

      yield* runCaaraInstallCodexRoles({
        args: ["--agents-md", "--panel-skill"],
        env: fixture.env,
      });

      const agents = yield* readFile({ filePath: fixture.agentsFilePath });
      assert.ok(agents.includes("$panel"));
    }),
  );

  it.effect("--agents-md references $panel when the skill was installed earlier", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* runCaaraInstallCodexRoles({ args: ["--panel-skill"], env: fixture.env });

      yield* runCaaraInstallCodexRoles({ args: ["--agents-md"], env: fixture.env });

      const agents = yield* readFile({ filePath: fixture.agentsFilePath });
      assert.ok(agents.includes("$panel"));
    }),
  );

  it.effect("reruns keep the managed AGENTS.md block idempotent", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.tryPromise(() => fs.mkdir(fixture.codexHome, { recursive: true }));
      yield* Effect.tryPromise(() =>
        fs.writeFile(fixture.agentsFilePath, "# Mine\n\nKeep me.\n", "utf8"),
      );

      yield* runCaaraInstallCodexRoles({ args: ["--agents-md"], env: fixture.env });
      yield* runCaaraInstallCodexRoles({ args: ["--agents-md"], env: fixture.env });

      const agents = yield* readFile({ filePath: fixture.agentsFilePath });
      assert.ok(agents.includes("Keep me."));
      assert.strictEqual(agents.split(codexAgentsGuidanceBeginMarker()).length, 2);
    }),
  );

  it.effect("refuses an unmarked user-owned panel skill before writing anything", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const userSkillPath = path.join(fixture.skillDirectory, "SKILL.md");
      yield* Effect.tryPromise(() => fs.mkdir(fixture.skillDirectory, { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(userSkillPath, "my own skill\n", "utf8"));

      const result = yield* runCaaraInstallCodexRoles({
        args: ["--panel-skill", "--agents-md"],
        env: fixture.env,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /refused unmarked existing Codex panel skill/u);
      assert.strictEqual(yield* readFile({ filePath: userSkillPath }), "my own skill\n");
      assert.strictEqual(yield* pathExists({ filePath: fixture.rolesDirectory }), false);
      assert.strictEqual(yield* pathExists({ filePath: fixture.agentsFilePath }), false);
    }),
  );

  it.effect("refuses a corrupt AGENTS.md marker pair before writing anything", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.tryPromise(() => fs.mkdir(fixture.codexHome, { recursive: true }));
      yield* Effect.tryPromise(() =>
        fs.writeFile(
          fixture.agentsFilePath,
          `${codexAgentsGuidanceBeginMarker()}\norphan\n`,
          "utf8",
        ),
      );

      const result = yield* runCaaraInstallCodexRoles({
        args: ["--agents-md"],
        env: fixture.env,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /refused corrupt Codex AGENTS\.md/u);
      assert.strictEqual(yield* pathExists({ filePath: fixture.rolesDirectory }), false);
    }),
  );

  it.effect("requires a resolvable Codex home when opt-in flags are used", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const explicitTarget = path.join(root, "agents");

      const result = yield* runCaaraInstallCodexRoles({
        args: [explicitTarget, "--agents-md"],
        env: { CODEX_HOME: "", HOME: "", PATH: "" },
      });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /HOME or CODEX_HOME/u);
    }),
  );

  it.effect("uninstall removes the marked skill and managed guidance block", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.tryPromise(() => fs.mkdir(fixture.codexHome, { recursive: true }));
      yield* Effect.tryPromise(() =>
        fs.writeFile(fixture.agentsFilePath, "# Mine\n\nKeep me.\n", "utf8"),
      );
      yield* runCaaraInstallCodexRoles({
        args: ["--agents-md", "--panel-skill"],
        env: fixture.env,
      });

      const result = yield* runCaaraUninstallCodexRoles({ args: [], env: fixture.env });

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.message, /removed panel skill/u);
      assert.match(result.message, /removed Codex AGENTS\.md guidance/u);
      assert.strictEqual(yield* pathExists({ filePath: fixture.skillDirectory }), false);
      const agents = yield* readFile({ filePath: fixture.agentsFilePath });
      assert.ok(agents.includes("Keep me."));
      assert.ok(!agents.includes(codexAgentsGuidanceBeginMarker()));
    }),
  );

  it.effect("uninstall deletes an AGENTS.md that held only the managed block", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* runCaaraInstallCodexRoles({ args: ["--agents-md"], env: fixture.env });

      yield* runCaaraUninstallCodexRoles({ args: [], env: fixture.env });

      assert.strictEqual(yield* pathExists({ filePath: fixture.agentsFilePath }), false);
    }),
  );

  it.effect("uninstall refuses a corrupt AGENTS.md before removing anything", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* runCaaraInstallCodexRoles({ args: ["--panel-skill"], env: fixture.env });
      yield* Effect.tryPromise(() =>
        fs.writeFile(
          fixture.agentsFilePath,
          `${codexAgentsGuidanceBeginMarker()}\norphan\n`,
          "utf8",
        ),
      );

      const result = yield* runCaaraUninstallCodexRoles({ args: [], env: fixture.env });

      assert.strictEqual(result.exitCode, 1);
      assert.match(result.message, /refused corrupt Codex AGENTS\.md/u);
      assert.strictEqual(
        yield* pathExists({ filePath: path.join(fixture.skillDirectory, "SKILL.md") }),
        true,
      );
      assert.strictEqual(
        yield* pathExists({
          filePath: path.join(fixture.rolesDirectory, "caara-claude-fable.toml"),
        }),
        true,
      );
    }),
  );

  it.effect("uninstall leaves user-owned panel skills in place", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const userSkillPath = path.join(fixture.skillDirectory, "SKILL.md");
      yield* Effect.tryPromise(() => fs.mkdir(fixture.skillDirectory, { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(userSkillPath, "mine\n", "utf8"));

      const result = yield* runCaaraUninstallCodexRoles({ args: [], env: fixture.env });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(yield* pathExists({ filePath: userSkillPath }), true);
      assert.ok(!result.message.includes("removed panel skill"));
    }),
  );
});
