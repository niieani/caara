import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Match } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Root directory scanned by the Claude CLI retirement architecture checks. */
const sourceRootPath = (): "src" => "src";

/** Pattern matching source files that belong to retired Claude CLI modules. */
const retiredClaudeCliSourcePattern = /(^|\/)(claudeCodeDriver|claudeCodeContract)\//u;

/** Source token for direct Bun process spawning, assembled to avoid self-matching this test. */
const bunSpawnCallToken = ["Bun", "spawn"].join(".");

/** Returns the file as a singleton list only when it is a TypeScript source file. */
const sourceFileSingleton = ({
  filePath,
  info,
}: {
  readonly filePath: string;
  readonly info: FileSystem.File.Info;
}): readonly string[] =>
  Match.value(
    info.type === "File" && filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"),
  ).pipe(
    Match.when(true, () => [filePath]),
    Match.orElse(() => []),
  );

/** Returns the file as a singleton list only when its contents include the token. */
const matchingFileSingleton = ({
  contents,
  filePath,
  token,
}: {
  readonly contents: string;
  readonly filePath: string;
  readonly token: string;
}): readonly string[] =>
  Match.value(contents.includes(token)).pipe(
    Match.when(true, () => [filePath]),
    Match.orElse(() => []),
  );

/** Lists TypeScript source files under the project source root. */
const sourceFilePaths = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(sourceRootPath(), { recursive: true });
  const sourceFiles = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const filePath = path.join(sourceRootPath(), entry);
      const info = yield* fs.stat(filePath);
      return sourceFileSingleton({ filePath, info });
    }),
  );
  return sourceFiles.flat();
});

/** Finds source files containing a forbidden text token. */
const sourceFilesContaining = Effect.fnUntraced(function* ({ token }: { readonly token: string }) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* sourceFilePaths();
  const matchingFiles = yield* Effect.forEach(files, (filePath) =>
    fs
      .readFileString(filePath, "utf8")
      .pipe(Effect.map((contents) => matchingFileSingleton({ contents, filePath, token }))),
  );
  return matchingFiles.flat();
});

describe("Claude CLI retirement", () => {
  it.effect("removes retired Claude Code CLI driver and contract sources", () =>
    Effect.gen(function* () {
      const files = yield* sourceFilePaths();
      const retiredFiles = files.filter((filePath) => retiredClaudeCliSourcePattern.test(filePath));

      assert.deepStrictEqual(retiredFiles, []);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps source free of direct Claude process spawning", () =>
    Effect.gen(function* () {
      const files = yield* sourceFilesContaining({ token: bunSpawnCallToken });

      assert.deepStrictEqual(files, []);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
