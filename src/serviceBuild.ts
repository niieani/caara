import path from "node:path";

import { Match, Option } from "effect";

/** Stable relative paths used by the Caara service build flow. */
export const serviceBuildPaths = {
  entrypoint: "src/caara.ts",
  currentHostOutput: "dist/caara",
  checksumsOutput: "dist/checksums.txt",
} as const;

/** Supported build modes for the service build script. */
export type BuildServiceMode = "current" | "all";

/** Supported release platforms for standalone service artifacts. */
export type ServiceArtifactPlatform = "darwin" | "linux";

/** Bun compile target string for one release service artifact. */
export type ServiceArtifactTarget =
  | "bun-darwin-arm64"
  | "bun-darwin-x64"
  | "bun-linux-arm64"
  | "bun-linux-x64";

/** Release artifact description used by build planning and checksum generation. */
export interface ServiceArtifact {
  readonly name: string;
  readonly bunTarget: ServiceArtifactTarget;
  readonly platform: ServiceArtifactPlatform;
  readonly outputPath: string;
}

/** One Bun compile invocation needed for a Caara service artifact. */
export interface ServiceCompileStep {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly target: ServiceArtifactTarget | undefined;
}

/** One external command invocation needed after compilation. */
export interface ServiceCommandStep {
  readonly command: readonly string[];
}

/** Complete build plan for the current-host or release service artifact set. */
export interface BuildServicePlan {
  readonly compileSteps: readonly ServiceCompileStep[];
  readonly codesignSteps: readonly ServiceCommandStep[];
  readonly checksumPaths: readonly string[];
}

/** One checksum value for a generated service artifact. */
export interface ServiceChecksum {
  readonly path: string;
  readonly sha256: string;
}

/** Release artifacts expected by GitHub release and future bootstrap flows. */
export const releaseServiceArtifacts: readonly ServiceArtifact[] = [
  {
    name: "caara-darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    platform: "darwin",
    outputPath: "dist/caara-darwin-arm64",
  },
  {
    name: "caara-darwin-x64",
    bunTarget: "bun-darwin-x64",
    platform: "darwin",
    outputPath: "dist/caara-darwin-x64",
  },
  {
    name: "caara-linux-arm64",
    bunTarget: "bun-linux-arm64",
    platform: "linux",
    outputPath: "dist/caara-linux-arm64",
  },
  {
    name: "caara-linux-x64",
    bunTarget: "bun-linux-x64",
    platform: "linux",
    outputPath: "dist/caara-linux-x64",
  },
] as const;

/** Converts one release artifact into a Bun compile step. */
const compileStepFromReleaseArtifact = ({
  artifact,
}: {
  readonly artifact: ServiceArtifact;
}): ServiceCompileStep => ({
  entrypoint: serviceBuildPaths.entrypoint,
  outfile: artifact.outputPath,
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
  command: ["codesign", "--force", "--deep", "--sign", codesignIdentity, artifact.outputPath],
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

/** Creates a deterministic service build plan without touching the filesystem. */
export const createBuildServicePlan = ({
  mode,
  codesignIdentity,
}: {
  readonly mode: BuildServiceMode;
  readonly codesignIdentity: string | undefined;
}): BuildServicePlan => {
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

  return {
    compileSteps,
    codesignSteps,
    checksumPaths: compileSteps.map((step) => step.outfile),
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
