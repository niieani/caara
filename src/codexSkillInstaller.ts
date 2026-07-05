import fs from "node:fs/promises";
import path from "node:path";

import { Effect, Match } from "effect";

import { caaraCodexRoleInstallerError } from "./codexRoleInstallerError.ts";
import { pathExists } from "./fsPathExists.ts";
import { panelSkillAssets } from "./panelSkillAssets.ts";

/** Returns the directory name of the globally installed panel skill under the Codex skills root. */
export const panelSkillDirectoryName = (): string => "panel";

/** Returns the marker filename identifying a Caara-owned installed skill directory. */
export const panelSkillMarkerFilename = (): string => ".caara-generated";

/** Returns the marker contents written into Caara-owned installed skill directories. */
const panelSkillMarkerContent = (): string => "caara-generated-skill = true\n";

/** Successful panel skill installation report. */
export interface PanelSkillInstalled {
  readonly _tag: "Installed";
  readonly skillDirectory: string;
  readonly writtenFiles: readonly string[];
}

/** Refusal to overwrite a user-owned skill directory. */
export interface PanelSkillCollision {
  readonly _tag: "Collision";
  readonly skillDirectory: string;
}

/** Panel skill installation outcome. */
export type PanelSkillInstallResult = PanelSkillInstalled | PanelSkillCollision;

/** Returns whether one existing skill directory carries the Caara ownership marker. */
const isMarkedSkillDirectory = Effect.fnUntraced(function* ({
  skillDirectory,
}: {
  readonly skillDirectory: string;
}) {
  return yield* pathExists({
    targetPath: path.join(skillDirectory, panelSkillMarkerFilename()),
  });
});

/** Writes one embedded skill asset, creating parent directories as needed. */
const writeSkillAsset = Effect.fnUntraced(function* ({
  content,
  filePath,
}: {
  readonly content: string;
  readonly filePath: string;
}) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(filePath), { recursive: true }),
    catch: (cause) =>
      caaraCodexRoleInstallerError(
        `Failed to create skill directory for ${filePath}: ${String(cause)}`,
      ),
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(filePath, content, "utf8"),
    catch: (cause) =>
      caaraCodexRoleInstallerError(`Failed to write skill file ${filePath}: ${String(cause)}`),
  });
  return filePath;
});

/** Removes one Caara-owned skill directory tree. */
const removeSkillDirectory = Effect.fnUntraced(function* ({
  skillDirectory,
}: {
  readonly skillDirectory: string;
}) {
  yield* Effect.tryPromise({
    try: () => fs.rm(skillDirectory, { force: true, recursive: true }),
    catch: (cause) =>
      caaraCodexRoleInstallerError(
        `Failed to remove skill directory ${skillDirectory}: ${String(cause)}`,
      ),
  });
});

/** Writes all embedded panel skill assets plus the ownership marker into one skill directory. */
const writePanelSkillTree = Effect.fnUntraced(function* ({
  skillDirectory,
}: {
  readonly skillDirectory: string;
}) {
  const assetFiles = yield* Effect.forEach(
    Object.entries(panelSkillAssets),
    ([relativePath, content]) =>
      writeSkillAsset({
        content,
        filePath: path.join(skillDirectory, relativePath),
      }),
    { concurrency: 1 },
  );
  const markerFile = yield* writeSkillAsset({
    content: panelSkillMarkerContent(),
    filePath: path.join(skillDirectory, panelSkillMarkerFilename()),
  });
  return [...assetFiles, markerFile];
});

/**
 * Returns the skill directory path when an unmarked user-owned panel skill would block
 * installation, or undefined when installation can proceed.
 */
export const panelSkillCollisionPath = Effect.fnUntraced(function* ({
  skillsDirectory,
}: {
  readonly skillsDirectory: string;
}) {
  const skillDirectory = path.join(skillsDirectory, panelSkillDirectoryName());
  const exists = yield* pathExists({ targetPath: skillDirectory });
  const marked = yield* isMarkedSkillDirectory({ skillDirectory });
  return [skillDirectory].filter(() => exists && !marked).at(0);
});

/** Returns whether any panel skill (Caara-owned or user-owned) is installed. */
export const isPanelSkillPresent = Effect.fnUntraced(function* ({
  skillsDirectory,
}: {
  readonly skillsDirectory: string;
}) {
  return yield* pathExists({
    targetPath: path.join(skillsDirectory, panelSkillDirectoryName(), "SKILL.md"),
  });
});

/**
 * Installs the embedded panel skill into the Codex skills directory.
 * A marked existing installation is replaced wholesale; an unmarked directory is user-owned and
 * reported as a collision without touching any file.
 */
export const installPanelSkill = Effect.fnUntraced(function* ({
  skillsDirectory,
}: {
  readonly skillsDirectory: string;
}) {
  const skillDirectory = path.join(skillsDirectory, panelSkillDirectoryName());
  const exists = yield* pathExists({ targetPath: skillDirectory });
  const marked = yield* isMarkedSkillDirectory({ skillDirectory });
  return yield* Match.value({ exists, marked }).pipe(
    Match.when({ exists: true, marked: false }, () =>
      Effect.succeed({
        _tag: "Collision",
        skillDirectory,
      } satisfies PanelSkillInstallResult),
    ),
    Match.orElse(() =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [skillDirectory].filter(() => marked),
          (ownedDirectory) => removeSkillDirectory({ skillDirectory: ownedDirectory }),
          { concurrency: 1 },
        );
        const writtenFiles = yield* writePanelSkillTree({ skillDirectory });
        return {
          _tag: "Installed",
          skillDirectory,
          writtenFiles,
        } satisfies PanelSkillInstallResult;
      }),
    ),
  );
});

/**
 * Removes the globally installed panel skill when Caara owns it.
 * Returns the removed directory path, or undefined when absent or user-owned.
 */
export const removePanelSkill = Effect.fnUntraced(function* ({
  skillsDirectory,
}: {
  readonly skillsDirectory: string;
}) {
  const skillDirectory = path.join(skillsDirectory, panelSkillDirectoryName());
  const marked = yield* isMarkedSkillDirectory({ skillDirectory });
  const removedDirectories = yield* Effect.forEach(
    [skillDirectory].filter(() => marked),
    (ownedDirectory) =>
      removeSkillDirectory({ skillDirectory: ownedDirectory }).pipe(
        Effect.map(() => ownedDirectory),
      ),
    { concurrency: 1 },
  );
  return removedDirectories.at(0);
});
