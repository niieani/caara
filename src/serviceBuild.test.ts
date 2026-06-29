import { assert, describe, it } from "@effect/vitest";

import {
  createBuildServicePlan,
  formatChecksumFile,
  releaseServiceArtifacts,
  serviceBuildPaths,
} from "./serviceBuild.ts";

describe("Caara service build artifacts", () => {
  it("maps release artifacts to Bun compile targets and output names", () => {
    assert.deepStrictEqual(releaseServiceArtifacts, [
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
    ]);

    const plan = createBuildServicePlan({
      mode: "all",
      codesignIdentity: undefined,
    });

    assert.deepStrictEqual(
      plan.compileSteps.map((step) => ({
        entrypoint: step.entrypoint,
        outfile: step.outfile,
        target: step.target,
      })),
      releaseServiceArtifacts.map((artifact) => ({
        entrypoint: serviceBuildPaths.entrypoint,
        outfile: artifact.outputPath,
        target: artifact.bunTarget,
      })),
    );
    assert.deepStrictEqual(
      plan.checksumPaths,
      releaseServiceArtifacts.map((artifact) => artifact.outputPath),
    );
  });

  it("builds the current-host executable as dist/caara without a cross target", () => {
    const plan = createBuildServicePlan({
      mode: "current",
      codesignIdentity: undefined,
    });

    assert.deepStrictEqual(plan.compileSteps, [
      {
        entrypoint: serviceBuildPaths.entrypoint,
        outfile: "dist/caara",
        target: undefined,
      },
    ]);
    assert.deepStrictEqual(plan.checksumPaths, ["dist/caara"]);
  });

  it("selects codesign commands for macOS artifacts only", () => {
    const plan = createBuildServicePlan({
      mode: "all",
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
          "dist/caara-darwin-arm64",
        ],
        [
          "codesign",
          "--force",
          "--deep",
          "--sign",
          "Developer ID Application: Example",
          "dist/caara-darwin-x64",
        ],
      ],
    );
  });

  it("formats release checksum lines with sha256 and asset name", () => {
    const text = formatChecksumFile({
      checksums: [
        {
          path: "dist/caara-darwin-arm64",
          sha256: "a".repeat(64),
        },
        {
          path: "dist/caara-linux-x64",
          sha256: "b".repeat(64),
        },
      ],
    });

    assert.strictEqual(
      text,
      `${"a".repeat(64)}  caara-darwin-arm64\n${"b".repeat(64)}  caara-linux-x64\n`,
    );
  });
});
