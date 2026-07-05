import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { panelSkillAssets } from "./panelSkillAssets.ts";

/** Absolute path of the authoritative panel skill source directory. */
const panelSkillSourceDirectory = path.join(process.cwd(), ".agents", "skills", "panel");

/** Recursively lists relative file paths under one directory. */
const listRelativeFiles = Effect.fnUntraced(function* ({
  directory,
}: {
  readonly directory: string;
}) {
  const entries = yield* Effect.tryPromise(() =>
    fs.readdir(directory, { recursive: true, withFileTypes: true }),
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .toSorted();
});

describe("panel skill embedded assets", () => {
  it.effect("stays in sync with .agents/skills/panel sources", () =>
    Effect.gen(function* () {
      const sourceFiles = yield* listRelativeFiles({ directory: panelSkillSourceDirectory });
      assert.deepStrictEqual(Object.keys(panelSkillAssets).toSorted(), sourceFiles);

      const contents = yield* Effect.forEach(sourceFiles, (relativePath) =>
        Effect.tryPromise(() =>
          fs.readFile(path.join(panelSkillSourceDirectory, relativePath), "utf8"),
        ),
      );
      sourceFiles.forEach((relativePath, index) => {
        assert.strictEqual(
          panelSkillAssets[relativePath],
          contents[index],
          `embedded asset drifted: ${relativePath}`,
        );
      });
    }),
  );
});
