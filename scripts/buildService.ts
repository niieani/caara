#!/usr/bin/env bun

import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Schema } from "effect";

import {
  archiveCommandFromStep,
  createBuildServicePlan,
  formatChecksumFile,
  serviceBuildPaths,
  type BuildServiceMode,
  type BuildServicePlan,
  type ServiceArchiveStep,
  type ServiceChecksum,
  type ServiceCommandStep,
  type ServiceCompileStep,
} from "../src/serviceBuild.ts";

/** Parsed command-line options for the service build script. */
interface ParsedBuildServiceArgs {
  readonly mode: BuildServiceMode;
  readonly codesignIdentity: string | undefined;
}

/** Build script failure with a user-facing message. */
class BuildServiceError extends Schema.TaggedErrorClass<BuildServiceError>()("BuildServiceError", {
  message: Schema.String,
}) {}

/** Package metadata required to version public release artifacts. */
const PackageBuildMetadata = Schema.Struct({
  version: Schema.String,
});

/** Builds one service build error. */
const buildServiceError = ({ message }: { readonly message: string }): BuildServiceError =>
  new BuildServiceError({ message });

/** Parses service build script arguments. */
const parseBuildServiceArgs = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  let mode: BuildServiceMode = "current";
  let codesignIdentity: string | undefined;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (arg === "--all") {
      mode = "all";
      index += 1;
    } else if (arg === "--codesign-identity") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return yield* buildServiceError({ message: "--codesign-identity requires a value." });
      }
      codesignIdentity = value;
      index += 2;
    } else if (arg?.startsWith("--codesign-identity=") === true) {
      const value = arg.slice("--codesign-identity=".length);
      if (value.length === 0) {
        return yield* buildServiceError({ message: "--codesign-identity requires a value." });
      }
      codesignIdentity = value;
      index += 1;
    } else {
      return yield* buildServiceError({
        message: `Unsupported service build option: ${arg ?? "<missing>"}.`,
      });
    }
  }

  return {
    mode,
    codesignIdentity,
  } satisfies ParsedBuildServiceArgs;
});

/** Ensures the parent directory for a generated artifact exists. */
const ensureOutputDirectory = Effect.fnUntraced(function* ({
  outputPath,
}: {
  readonly outputPath: string;
}) {
  yield* Effect.tryPromise({
    try: () => mkdir(path.dirname(outputPath), { recursive: true }),
    catch: () =>
      buildServiceError({
        message: `Failed to create output directory for ${outputPath}.`,
      }),
  });
});

/** Reads and validates the package version used in public release artifact names. */
const readPackageVersion = Effect.fnUntraced(function* () {
  const json = yield* Effect.tryPromise({
    try: () => Bun.file("package.json").json(),
    catch: () =>
      buildServiceError({
        message: "Failed to read package.json for release artifact version.",
      }),
  });
  const metadata = yield* Schema.decodeUnknownEffect(PackageBuildMetadata)(json).pipe(
    Effect.mapError((cause) =>
      buildServiceError({
        message: `Invalid package.json release metadata: ${String(cause)}.`,
      }),
    ),
  );

  return metadata.version;
});

/** Runs one Bun compile step for a service artifact. */
const runCompileStep = Effect.fnUntraced(function* (step: ServiceCompileStep) {
  yield* ensureOutputDirectory({ outputPath: step.outfile });
  yield* Console.log(`Building ${step.outfile}`);
  const compile =
    step.target === undefined
      ? {
          outfile: step.outfile,
        }
      : {
          outfile: step.outfile,
          target: step.target,
        };

  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [step.entrypoint],
        compile,
      }),
    catch: () =>
      buildServiceError({
        message: `Bun compile failed for ${step.outfile}.`,
      }),
  });

  if (!result.success) {
    return yield* buildServiceError({
      message: `Bun compile failed for ${step.outfile}.`,
    });
  }
});

/** Runs one external service build command and fails on nonzero exit. */
const runCommandStep = Effect.fnUntraced(function* (step: ServiceCommandStep) {
  yield* Console.log(step.command.join(" "));
  const process = Bun.spawn([...step.command], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = yield* Effect.tryPromise({
    try: () => process.exited,
    catch: () =>
      buildServiceError({
        message: `Command failed to start: ${step.command.join(" ")}.`,
      }),
  });

  if (exitCode !== 0) {
    return yield* buildServiceError({
      message: `Command exited ${exitCode}: ${step.command.join(" ")}.`,
    });
  }
});

/** Copies one release metadata file into a tarball staging directory. */
const copyReleaseMetadataFile = Effect.fnUntraced(function* ({
  sourcePath,
  stagingDirectory,
}: {
  readonly sourcePath: string;
  readonly stagingDirectory: string;
}) {
  const targetPath = path.join(stagingDirectory, path.basename(sourcePath));
  yield* Effect.tryPromise({
    try: () => copyFile(sourcePath, targetPath),
    catch: () =>
      buildServiceError({
        message: `Failed to copy ${sourcePath} into release archive staging.`,
      }),
  });
});

/** Prepares the tarball staging directory after compilation and before archive creation. */
const prepareArchiveStep = Effect.fnUntraced(function* (step: ServiceArchiveStep) {
  yield* ensureOutputDirectory({ outputPath: path.join(step.stagingDirectory, "README.md") });
  yield* copyReleaseMetadataFile({
    sourcePath: serviceBuildPaths.releaseReadme,
    stagingDirectory: step.stagingDirectory,
  });
  yield* copyReleaseMetadataFile({
    sourcePath: serviceBuildPaths.releaseLicense,
    stagingDirectory: step.stagingDirectory,
  });
  yield* Effect.tryPromise({
    try: () => chmod(path.join(step.stagingDirectory, "caara"), 0o755),
    catch: () =>
      buildServiceError({
        message: `Failed to mark release executable as executable: ${path.join(step.stagingDirectory, "caara")}.`,
      }),
  });
});

/** Creates one compressed release tarball from its prepared staging directory. */
const runArchiveStep = Effect.fnUntraced(function* (step: ServiceArchiveStep) {
  yield* prepareArchiveStep(step);
  yield* ensureOutputDirectory({ outputPath: step.archivePath });
  yield* runCommandStep(archiveCommandFromStep(step));
});

/** Computes one SHA-256 checksum for a generated artifact. */
const checksumFile = Effect.fnUntraced(function* ({
  artifactPath,
}: {
  readonly artifactPath: string;
}) {
  const bytes = yield* Effect.tryPromise({
    try: () => Bun.file(artifactPath).arrayBuffer(),
    catch: () =>
      buildServiceError({
        message: `Failed to read artifact for checksum: ${artifactPath}.`,
      }),
  });
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  return {
    path: artifactPath,
    sha256,
  } satisfies ServiceChecksum;
});

/** Writes the service checksum manifest for every generated artifact in the plan. */
const writeChecksumFile = Effect.fnUntraced(function* ({
  checksumPaths,
}: {
  readonly checksumPaths: readonly string[];
}) {
  const checksums = yield* Effect.forEach(checksumPaths, (artifactPath) =>
    checksumFile({ artifactPath }),
  );
  const text = formatChecksumFile({ checksums });
  yield* ensureOutputDirectory({ outputPath: serviceBuildPaths.checksumsOutput });
  yield* Effect.tryPromise({
    try: () => Bun.write(serviceBuildPaths.checksumsOutput, text),
    catch: () =>
      buildServiceError({
        message: `Failed to write ${serviceBuildPaths.checksumsOutput}.`,
      }),
  });
  yield* Console.log(`Wrote ${serviceBuildPaths.checksumsOutput}`);
});

/** Executes a service build plan. */
const runBuildServicePlan = Effect.fnUntraced(function* (plan: BuildServicePlan) {
  yield* Effect.forEach(plan.compileSteps, runCompileStep, {
    concurrency: 1,
  });
  yield* Effect.forEach(plan.codesignSteps, runCommandStep, {
    concurrency: 1,
  });
  yield* Effect.forEach(plan.archiveSteps, runArchiveStep, {
    concurrency: 1,
  });
  yield* writeChecksumFile({ checksumPaths: plan.checksumPaths });
});

/** Parses CLI args, builds the service plan, and executes it. */
const runBuildServiceCli = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  const parsed = yield* parseBuildServiceArgs({ args });
  const version = yield* readPackageVersion();
  const plan = createBuildServicePlan({
    ...parsed,
    version,
  });
  yield* runBuildServicePlan(plan);
});

/** Runs the Caara standalone executable build script. */
BunRuntime.runMain(runBuildServiceCli({ args: process.argv.slice(2) }));
