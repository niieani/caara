import fs from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

/** Root package metadata that must stay safe for public binary/Homebrew releases. */
const PublicReleasePackageMetadata = Schema.Struct({
  name: Schema.Literal("caara"),
  private: Schema.Literal(true),
  version: Schema.Literal("1.0.0"),
  license: Schema.Literal("MIT"),
});

/** Release Please package configuration for the root Caara component. */
const ReleasePleaseRootPackageConfig = Schema.Struct({
  "release-type": Schema.Literal("node"),
  "package-name": Schema.Literal("caara"),
  "changelog-path": Schema.Literal("CHANGELOG.md"),
});

/** Release Please manifest config that lets Release Please own version/changelog/release state. */
const ReleasePleaseConfig = Schema.Struct({
  "release-type": Schema.Literal("node"),
  "include-component-in-tag": Schema.Literal(false),
  packages: Schema.Struct({
    ".": ReleasePleaseRootPackageConfig,
  }),
});

/** Release Please version manifest bootstrapped to the public 1.0.0 baseline. */
const ReleasePleaseManifest = Schema.Struct({
  ".": Schema.Literal("1.0.0"),
});

/** Reads one repository file as UTF-8 text for static metadata checks. */
const readWorkspaceFile = ({ filePath }: { readonly filePath: string }): string =>
  fs.readFileSync(path.join(process.cwd(), filePath), "utf8");

describe("public release metadata", () => {
  it("keeps package metadata private, versioned, and MIT licensed", () => {
    const packageMetadata = Schema.decodeUnknownSync(
      Schema.fromJsonString(PublicReleasePackageMetadata),
    )(readWorkspaceFile({ filePath: "package.json" }));

    assert.strictEqual(packageMetadata.private, true);
    assert.strictEqual(packageMetadata.version, "1.0.0");
    assert.strictEqual(packageMetadata.license, "MIT");
  });

  it("declares MIT licensing with Bazyli Brzoska as copyright holder", () => {
    const licenseText = readWorkspaceFile({ filePath: "LICENSE" });

    assert.match(licenseText, /^MIT License/u);
    assert.match(licenseText, /Copyright \(c\) 2026 Bazyli Brzóska/u);
    assert.match(licenseText, /Permission is hereby granted, free of charge/u);
  });

  it("configures Release Please without npm publication automation", () => {
    const releasePleaseConfig = Schema.decodeUnknownSync(
      Schema.fromJsonString(ReleasePleaseConfig),
    )(readWorkspaceFile({ filePath: "release-please-config.json" }));
    const releasePleaseManifest = Schema.decodeUnknownSync(
      Schema.fromJsonString(ReleasePleaseManifest),
    )(readWorkspaceFile({ filePath: ".release-please-manifest.json" }));
    const releaseWorkflow = readWorkspaceFile({
      filePath: ".github/workflows/release-please.yml",
    });

    assert.deepStrictEqual(releasePleaseConfig.packages["."], {
      "release-type": "node",
      "package-name": "caara",
      "changelog-path": "CHANGELOG.md",
    });
    assert.strictEqual(releasePleaseManifest["."], "1.0.0");
    assert.match(releaseWorkflow, /googleapis\/release-please-action@v4/u);
    assert.strictEqual(/npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/u.test(releaseWorkflow), false);
  });
});
