import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  archiveCommandFromStep,
  createBuildServicePlan,
  createReleaseServiceArtifacts,
  formatChecksumFile,
  type ServiceCommandArguments,
  serviceBuildPaths,
} from "./serviceBuild.ts";

/** Builds one isolated release artifact smoke root under temp.local. */
const smokeRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-03", `service-build-${randomUUID()}`);

/** Creates one directory for release artifact smoke tests. */
const makeDirectory = Effect.fnUntraced(function* ({ dirPath }: { readonly dirPath: string }) {
  yield* Effect.tryPromise(() => fs.mkdir(dirPath, { recursive: true }));
});

/** Writes one smoke fixture file and optionally marks it executable. */
const writeSmokeFile = Effect.fnUntraced(function* ({
  filePath,
  content,
  mode,
}: {
  readonly filePath: string;
  readonly content: string;
  readonly mode: number | undefined;
}) {
  yield* makeDirectory({ dirPath: path.dirname(filePath) });
  yield* Effect.tryPromise(() => fs.writeFile(filePath, content, "utf8"));
  yield* Option.match(Option.fromUndefinedOr(mode), {
    onNone: () => Effect.void,
    onSome: (fileMode) => Effect.tryPromise(() => fs.chmod(filePath, fileMode)),
  });
});

/** Result from one smoke-test command execution. */
interface SmokeCommandResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

/** Spawns one command and captures stderr for release artifact smoke tests. */
const spawnSmokeCommand = (command: ServiceCommandArguments): Promise<SmokeCommandResult> =>
  new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({
        exitCode,
        stderr,
      }),
    );
  });

/** Runs one external command for release artifact smoke tests. */
const runSmokeCommand = Effect.fnUntraced(function* (command: ServiceCommandArguments) {
  const result = yield* Effect.tryPromise(() => spawnSmokeCommand(command));
  assert.strictEqual(result.exitCode, 0, `${command.join(" ")} failed: ${result.stderr}`);
});

describe("Caara service build artifacts", () => {
  it("maps release artifacts to versioned public tarballs and Bun compile targets", () => {
    const artifacts = createReleaseServiceArtifacts({ version: "1.2.3" });

    assert.deepStrictEqual(artifacts, [
      {
        archiveName: "caara_1.2.3_darwin_arm64.tar.gz",
        archiveOutputPath: "dist/caara_1.2.3_darwin_arm64.tar.gz",
        binaryOutputPath: "dist/release/caara_1.2.3_darwin_arm64/caara",
        bunTarget: "bun-darwin-arm64",
        platformArchitecture: "arm64",
        platform: "darwin",
        stagingDirectory: "dist/release/caara_1.2.3_darwin_arm64",
      },
      {
        archiveName: "caara_1.2.3_linux_amd64.tar.gz",
        archiveOutputPath: "dist/caara_1.2.3_linux_amd64.tar.gz",
        binaryOutputPath: "dist/release/caara_1.2.3_linux_amd64/caara",
        bunTarget: "bun-linux-x64",
        platformArchitecture: "amd64",
        platform: "linux",
        stagingDirectory: "dist/release/caara_1.2.3_linux_amd64",
      },
      {
        archiveName: "caara_1.2.3_linux_arm64.tar.gz",
        archiveOutputPath: "dist/caara_1.2.3_linux_arm64.tar.gz",
        binaryOutputPath: "dist/release/caara_1.2.3_linux_arm64/caara",
        bunTarget: "bun-linux-arm64",
        platformArchitecture: "arm64",
        platform: "linux",
        stagingDirectory: "dist/release/caara_1.2.3_linux_arm64",
      },
    ]);
    assert.deepStrictEqual(
      artifacts.map((artifact) => artifact.archiveName),
      [
        "caara_1.2.3_darwin_arm64.tar.gz",
        "caara_1.2.3_linux_amd64.tar.gz",
        "caara_1.2.3_linux_arm64.tar.gz",
      ],
    );
    assert.strictEqual(
      artifacts.some((artifact) => artifact.archiveName.includes("darwin_x64")),
      false,
    );

    const plan = createBuildServicePlan({
      mode: "all",
      version: "1.2.3",
      codesignIdentity: undefined,
    });

    assert.deepStrictEqual(
      plan.compileSteps.map((step) => ({
        entrypoint: step.entrypoint,
        outfile: step.outfile,
        target: step.target,
      })),
      artifacts.map((artifact) => ({
        entrypoint: serviceBuildPaths.entrypoint,
        outfile: artifact.binaryOutputPath,
        target: artifact.bunTarget,
      })),
    );
    assert.deepStrictEqual(
      plan.archiveSteps.map((step) => ({
        archivePath: step.archivePath,
        entries: step.entries,
        stagingDirectory: step.stagingDirectory,
      })),
      artifacts.map((artifact) => ({
        archivePath: artifact.archiveOutputPath,
        entries: ["caara", "README.md", "LICENSE"],
        stagingDirectory: artifact.stagingDirectory,
      })),
    );
    assert.deepStrictEqual(
      plan.checksumPaths,
      artifacts.map((artifact) => artifact.archiveOutputPath),
    );
  });

  it("builds the current-host executable as dist/caara without a cross target", () => {
    const plan = createBuildServicePlan({
      mode: "current",
      version: "1.2.3",
      codesignIdentity: undefined,
    });

    assert.deepStrictEqual(plan.compileSteps, [
      {
        entrypoint: serviceBuildPaths.entrypoint,
        outfile: "dist/caara",
        target: undefined,
      },
    ]);
    assert.deepStrictEqual(plan.archiveSteps, []);
    assert.deepStrictEqual(plan.checksumPaths, ["dist/caara"]);
  });

  it("selects codesign commands for macOS artifacts only", () => {
    const plan = createBuildServicePlan({
      mode: "all",
      version: "1.2.3",
      codesignIdentity: "Developer ID Application: Example",
    });

    assert.deepStrictEqual(
      plan.codesignSteps.map((step) => step.command),
      [
        [
          "codesign",
          "--force",
          "--deep",
          "--sign",
          "Developer ID Application: Example",
          "dist/release/caara_1.2.3_darwin_arm64/caara",
        ],
      ],
    );
  });

  it("formats release checksum lines with sha256 and asset name", () => {
    const text = formatChecksumFile({
      checksums: [
        {
          path: "dist/caara_1.2.3_darwin_arm64.tar.gz",
          sha256: "a".repeat(64),
        },
        {
          path: "dist/caara_1.2.3_linux_amd64.tar.gz",
          sha256: "b".repeat(64),
        },
      ],
    });

    assert.strictEqual(
      text,
      `${"a".repeat(64)}  caara_1.2.3_darwin_arm64.tar.gz\n${"b".repeat(64)}  caara_1.2.3_linux_amd64.tar.gz\n`,
    );
  });

  it.effect("creates and extracts a release tarball with executable and metadata", () =>
    Effect.gen(function* () {
      const root = smokeRoot();
      const stagingDirectory = path.join(root, "staging");
      const archivePath = path.join(root, "dist", "caara_1.2.3_darwin_arm64.tar.gz");
      const extractDirectory = path.join(root, "extract");
      yield* writeSmokeFile({
        filePath: path.join(stagingDirectory, "caara"),
        content: "#!/bin/sh\n",
        mode: 0o755,
      });
      yield* writeSmokeFile({
        filePath: path.join(stagingDirectory, "README.md"),
        content: "# Caara\n",
        mode: undefined,
      });
      yield* writeSmokeFile({
        filePath: path.join(stagingDirectory, "LICENSE"),
        content: "MIT\n",
        mode: undefined,
      });
      yield* makeDirectory({ dirPath: path.dirname(archivePath) });
      yield* makeDirectory({ dirPath: extractDirectory });

      yield* runSmokeCommand(
        archiveCommandFromStep({
          archivePath,
          entries: ["caara", "README.md", "LICENSE"],
          stagingDirectory,
        }).command,
      );
      yield* runSmokeCommand(["tar", "-xzf", archivePath, "-C", extractDirectory]);

      const binaryPath = path.join(extractDirectory, "caara");
      const binaryExists = yield* Effect.tryPromise(() => Bun.file(binaryPath).exists());
      const readmeExists = yield* Effect.tryPromise(() =>
        Bun.file(path.join(extractDirectory, "README.md")).exists(),
      );
      const licenseExists = yield* Effect.tryPromise(() =>
        Bun.file(path.join(extractDirectory, "LICENSE")).exists(),
      );
      const binaryStats = yield* Effect.tryPromise(() => fs.stat(binaryPath));
      assert.strictEqual(binaryExists, true);
      assert.strictEqual(readmeExists, true);
      assert.strictEqual(licenseExists, true);
      assert.notStrictEqual(binaryStats.mode & 0o111, 0);
    }),
  );
});
