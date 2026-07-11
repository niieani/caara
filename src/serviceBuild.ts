import path from "node:path";

import { Match, Option } from "effect";

/** Stable relative paths used by the Caara service build flow. */
export const serviceBuildPaths = {
  entrypoint: "src/caara.ts",
  currentHostOutput: "dist/caara",
  checksumsOutput: "dist/checksums.txt",
  macosEntitlements: "config/caara.entitlements.plist",
  releaseLicense: "LICENSE",
  releaseReadme: "README.md",
} as const;

/** Supported build modes for the service build script. */
export type BuildServiceMode = "current" | "all";

/** Supported release platforms for standalone service artifacts. */
export type ServiceArtifactPlatform = "darwin" | "linux";

/** Public release CPU architecture token used in tarball names. */
export type ServiceArtifactPlatformArchitecture = "arm64" | "amd64";

/** Bun compile target string for one release service artifact. */
export type ServiceArtifactTarget = "bun-darwin-arm64" | "bun-linux-arm64" | "bun-linux-x64";

/** Version-independent platform specification for one public release artifact. */
export interface ServiceArtifactSpec {
  readonly bunTarget: ServiceArtifactTarget;
  readonly platform: ServiceArtifactPlatform;
  readonly platformArchitecture: ServiceArtifactPlatformArchitecture;
}

/** Release artifact description used by build planning and checksum generation. */
export interface ServiceArtifact {
  readonly archiveName: string;
  readonly archiveOutputPath: string;
  readonly binaryOutputPath: string;
  readonly bunTarget: ServiceArtifactTarget;
  readonly platformArchitecture: ServiceArtifactPlatformArchitecture;
  readonly platform: ServiceArtifactPlatform;
  readonly stagingDirectory: string;
}

/** One Bun compile invocation needed for a Caara service artifact. */
export interface ServiceCompileStep {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly target: ServiceArtifactTarget | undefined;
}

/** Non-empty command argument vector for one external service build command. */
export type ServiceCommandArguments = readonly [string, ...string[]];

/** One external command invocation needed after compilation. */
export interface ServiceCommandStep {
  readonly command: ServiceCommandArguments;
}

/** One tarball archive creation step for a compiled release artifact. */
export interface ServiceArchiveStep {
  readonly archivePath: string;
  readonly entries: readonly string[];
  readonly stagingDirectory: string;
}

/** Complete build plan for the current-host or release service artifact set. */
export interface BuildServicePlan {
  readonly compileSteps: readonly ServiceCompileStep[];
  readonly codesignSteps: readonly ServiceCommandStep[];
  readonly archiveSteps: readonly ServiceArchiveStep[];
  readonly checksumPaths: readonly string[];
}

/** One checksum value for a generated service artifact. */
export interface ServiceChecksum {
  readonly path: string;
  readonly sha256: string;
}

/** Release archive entries included in every public tarball. */
export const releaseArchiveEntries = ["caara", "README.md", "LICENSE"] as const;

/** Public release platform matrix expected by GitHub release and Homebrew flows. */
export const releaseServiceArtifactSpecs: readonly ServiceArtifactSpec[] = [
  {
    bunTarget: "bun-darwin-arm64",
    platform: "darwin",
    platformArchitecture: "arm64",
  },
  {
    bunTarget: "bun-linux-x64",
    platform: "linux",
    platformArchitecture: "amd64",
  },
  {
    bunTarget: "bun-linux-arm64",
    platform: "linux",
    platformArchitecture: "arm64",
  },
] as const;

/** Builds the versioned release asset stem shared by staging directory and archive name. */
const releaseArtifactStem = ({
  version,
  spec,
}: {
  readonly version: string;
  readonly spec: ServiceArtifactSpec;
}): string => `caara_${version}_${spec.platform}_${spec.platformArchitecture}`;

/** Builds one versioned release artifact descriptor for a package version and platform. */
const releaseServiceArtifactFromSpec = ({
  version,
  spec,
}: {
  readonly version: string;
  readonly spec: ServiceArtifactSpec;
}): ServiceArtifact => {
  const stem = releaseArtifactStem({ version, spec });
  const stagingDirectory = path.join("dist", "release", stem);

  return {
    archiveName: `${stem}.tar.gz`,
    archiveOutputPath: path.join("dist", `${stem}.tar.gz`),
    binaryOutputPath: path.join(stagingDirectory, "caara"),
    bunTarget: spec.bunTarget,
    platform: spec.platform,
    platformArchitecture: spec.platformArchitecture,
    stagingDirectory,
  };
};

/** Builds all versioned release artifact descriptors for one package version. */
export const createReleaseServiceArtifacts = ({
  version,
}: {
  readonly version: string;
}): readonly ServiceArtifact[] =>
  releaseServiceArtifactSpecs.map((spec) => releaseServiceArtifactFromSpec({ version, spec }));

/** Converts one release artifact into a Bun compile step. */
const compileStepFromReleaseArtifact = ({
  artifact,
}: {
  readonly artifact: ServiceArtifact;
}): ServiceCompileStep => ({
  entrypoint: serviceBuildPaths.entrypoint,
  outfile: artifact.binaryOutputPath,
  target: artifact.bunTarget,
});

/** Builds the current-host Bun compile step. */
const currentHostCompileStep = (): ServiceCompileStep => ({
  entrypoint: serviceBuildPaths.entrypoint,
  outfile: serviceBuildPaths.currentHostOutput,
  target: undefined,
});

/** Builds one macOS codesign command. */
const codesignStepFromReleaseArtifact = ({
  artifact,
  codesignIdentity,
}: {
  readonly artifact: ServiceArtifact;
  readonly codesignIdentity: string;
}): ServiceCommandStep => ({
  command: [
    "codesign",
    "--force",
    "--deep",
    "--sign",
    codesignIdentity,
    "--entitlements",
    serviceBuildPaths.macosEntitlements,
    artifact.binaryOutputPath,
  ],
});

/** Builds all macOS codesign steps selected by the requested release artifacts. */
const createCodesignSteps = ({
  codesignIdentity,
  artifacts,
}: {
  readonly codesignIdentity: string | undefined;
  readonly artifacts: readonly ServiceArtifact[];
}): readonly ServiceCommandStep[] =>
  Option.match(Option.fromUndefinedOr(codesignIdentity), {
    onNone: () => [],
    onSome: (identity) =>
      artifacts
        .filter((artifact) => artifact.platform === "darwin")
        .map((artifact) =>
          codesignStepFromReleaseArtifact({
            artifact,
            codesignIdentity: identity,
          }),
        ),
  });

/** Converts one release artifact into a tarball archive step. */
const archiveStepFromReleaseArtifact = ({
  artifact,
}: {
  readonly artifact: ServiceArtifact;
}): ServiceArchiveStep => ({
  archivePath: artifact.archiveOutputPath,
  entries: releaseArchiveEntries,
  stagingDirectory: artifact.stagingDirectory,
});

/** Converts one tarball archive step into the external tar command. */
export const archiveCommandFromStep = (step: ServiceArchiveStep): ServiceCommandStep => ({
  command: ["tar", "-czf", step.archivePath, "-C", step.stagingDirectory, ...step.entries],
});

/** Creates a deterministic service build plan without touching the filesystem. */
export const createBuildServicePlan = ({
  mode,
  version,
  codesignIdentity,
}: {
  readonly mode: BuildServiceMode;
  readonly version: string;
  readonly codesignIdentity: string | undefined;
}): BuildServicePlan => {
  const releaseServiceArtifacts = createReleaseServiceArtifacts({ version });
  const releaseCompileSteps = releaseServiceArtifacts.map((artifact) =>
    compileStepFromReleaseArtifact({ artifact }),
  );
  const compileSteps = Match.value(mode).pipe(
    Match.when("all", () => releaseCompileSteps),
    Match.orElse(() => [currentHostCompileStep()]),
  );
  const codesignSteps = Match.value(mode).pipe(
    Match.when("all", () =>
      createCodesignSteps({
        artifacts: releaseServiceArtifacts,
        codesignIdentity,
      }),
    ),
    Match.orElse(() => []),
  );
  const archiveSteps = Match.value(mode).pipe(
    Match.when("all", () =>
      releaseServiceArtifacts.map((artifact) => archiveStepFromReleaseArtifact({ artifact })),
    ),
    Match.orElse(() => []),
  );
  const checksumPaths = Match.value(mode).pipe(
    Match.when("all", () => archiveSteps.map((step) => step.archivePath)),
    Match.orElse(() => compileSteps.map((step) => step.outfile)),
  );

  return {
    compileSteps,
    codesignSteps,
    archiveSteps,
    checksumPaths,
  };
};

/** Formats the release checksum manifest using the conventional sha256sum shape. */
export const formatChecksumFile = ({
  checksums,
}: {
  readonly checksums: readonly ServiceChecksum[];
}): string =>
  checksums.map((checksum) => `${checksum.sha256}  ${path.basename(checksum.path)}`).join("\n") +
  "\n";
