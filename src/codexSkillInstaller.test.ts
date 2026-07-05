import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Match } from "effect";

import {
  installPanelSkill,
  panelSkillMarkerFilename,
  removePanelSkill,
  type PanelSkillInstallResult,
} from "./codexSkillInstaller.ts";
import { panelSkillAssets } from "./panelSkillAssets.ts";

/** Extracts the written file list from one install result or fails the test. */
const installedFiles = (result: PanelSkillInstallResult): readonly string[] =>
  Match.valueTags(result, {
    Collision: ({ skillDirectory }) =>
      assert.fail(`expected installation, got collision: ${skillDirectory}`),
    Installed: ({ writtenFiles }) => writtenFiles,
  });

/** Builds one isolated skill installer test root under temp.local. */
const testRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-04", `codex-skill-${randomUUID()}`);

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

describe("Caara panel skill installer", () => {
  it.effect("installs every embedded asset plus the ownership marker", () =>
    Effect.gen(function* () {
      const skillsDirectory = path.join(testRoot(), "skills");

      const result = yield* installPanelSkill({ skillsDirectory });

      assert.strictEqual(result._tag, "Installed");
      const skillDirectory = path.join(skillsDirectory, "panel");
      const skillMd = yield* readFile({ filePath: path.join(skillDirectory, "SKILL.md") });
      assert.strictEqual(skillMd, panelSkillAssets["SKILL.md"]);
      const ensemble = yield* readFile({
        filePath: path.join(skillDirectory, "strategies", "ensemble.md"),
      });
      assert.strictEqual(ensemble, panelSkillAssets["strategies/ensemble.md"]);
      assert.strictEqual(
        yield* pathExists({ filePath: path.join(skillDirectory, panelSkillMarkerFilename()) }),
        true,
      );
      assert.strictEqual(installedFiles(result).length, Object.keys(panelSkillAssets).length + 1);
    }),
  );

  it.effect("refuses to overwrite an unmarked user-owned skill directory", () =>
    Effect.gen(function* () {
      const skillsDirectory = path.join(testRoot(), "skills");
      const userSkillPath = path.join(skillsDirectory, "panel", "SKILL.md");
      yield* Effect.tryPromise(() => fs.mkdir(path.dirname(userSkillPath), { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(userSkillPath, "my own panel skill\n", "utf8"));

      const result = yield* installPanelSkill({ skillsDirectory });

      assert.strictEqual(result._tag, "Collision");
      const preserved = yield* readFile({ filePath: userSkillPath });
      assert.strictEqual(preserved, "my own panel skill\n");
    }),
  );

  it.effect("reinstalls over a marked skill directory and drops stale files", () =>
    Effect.gen(function* () {
      const skillsDirectory = path.join(testRoot(), "skills");
      yield* installPanelSkill({ skillsDirectory });
      const skillDirectory = path.join(skillsDirectory, "panel");
      const stalePath = path.join(skillDirectory, "stale.md");
      yield* Effect.tryPromise(() => fs.writeFile(stalePath, "stale\n", "utf8"));
      yield* Effect.tryPromise(() =>
        fs.writeFile(path.join(skillDirectory, "SKILL.md"), "tampered\n", "utf8"),
      );

      const result = yield* installPanelSkill({ skillsDirectory });

      assert.strictEqual(result._tag, "Installed");
      assert.strictEqual(yield* pathExists({ filePath: stalePath }), false);
      const skillMd = yield* readFile({ filePath: path.join(skillDirectory, "SKILL.md") });
      assert.strictEqual(skillMd, panelSkillAssets["SKILL.md"]);
    }),
  );

  it.effect("removes only marked skill directories", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const skillsDirectory = path.join(root, "skills");
      yield* installPanelSkill({ skillsDirectory });

      const removed = yield* removePanelSkill({ skillsDirectory });
      assert.notStrictEqual(removed, undefined);
      assert.strictEqual(
        yield* pathExists({ filePath: path.join(skillsDirectory, "panel") }),
        false,
      );

      const userSkillPath = path.join(skillsDirectory, "panel", "SKILL.md");
      yield* Effect.tryPromise(() => fs.mkdir(path.dirname(userSkillPath), { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(userSkillPath, "mine\n", "utf8"));
      const kept = yield* removePanelSkill({ skillsDirectory });
      assert.strictEqual(kept, undefined);
      assert.strictEqual(yield* pathExists({ filePath: userSkillPath }), true);
    }),
  );

  it.effect("treats an absent skill directory as already removed", () =>
    Effect.gen(function* () {
      const removed = yield* removePanelSkill({
        skillsDirectory: path.join(testRoot(), "skills"),
      });
      assert.strictEqual(removed, undefined);
    }),
  );
});
