import fs from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

/** Reads one workflow file from the repository root for release publish checks. */
const readWorkflow = (): string =>
  fs.readFileSync(path.join(process.cwd(), ".github/workflows/release-publish.yml"), "utf8");

describe("release publish workflow", () => {
  it("runs from published releases, Release Please completion, or manual dispatch with write release permissions", () => {
    const workflow = readWorkflow();

    assert.match(workflow, /^on:\n(?:.|\n)*release:\n(?:.|\n)*types:\s*\[published\]/mu);
    assert.match(
      workflow,
      /^on:\n(?:.|\n)*workflow_run:\n(?:.|\n)*workflows:\s*\[Release Please\]/mu,
    );
    assert.match(workflow, /^on:\n(?:.|\n)*workflow_run:\n(?:.|\n)*types:\s*\[completed\]/mu);
    assert.match(workflow, /^on:\n(?:.|\n)*workflow_dispatch:/mu);
    assert.match(workflow, /permissions:\n\s+contents: write/u);
    assert.match(workflow, /publish: \$\{\{ steps\.release\.outputs\.publish \}\}/u);
    assert.match(workflow, /github\.event\.workflow_run\.head_sha/u);
    assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/releases/u);
    assert.match(workflow, /target_commitish/u);
    assert.match(workflow, /No published release found for Release Please head SHA/u);
    assert.match(workflow, /if: needs\.resolve-release\.outputs\.publish == 'true'/u);
    assert.match(workflow, /VERSION: \$\{\{ needs\.resolve-release\.outputs\.version \}\}/u);
    assert.match(workflow, /TAG: \$\{\{ needs\.resolve-release\.outputs\.tag \}\}/u);
    assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/u);
    assert.match(workflow, /Release tag must start with v/u);
  });

  it("loads signing and tap credentials from 1Password using the service account token", () => {
    const workflow = readWorkflow();

    assert.match(workflow, /1password\/load-secrets-action\/configure@v3/u);
    assert.match(workflow, /1password\/load-secrets-action@v3/u);
    assert.match(workflow, /service-account-token: \$\{\{ secrets\.OP_SERVICE_ACCOUNT_TOKEN \}\}/u);
    assert.match(workflow, /op:\/\/Automation\/Apple Release Signing Developer ID Certificate/u);
    assert.match(
      workflow,
      /op:\/\/Automation\/Apple Developer App Store Connect AuthKey Github Releases/u,
    );
    assert.match(workflow, /op:\/\/Automation\/GitHub Token for homebrew-tap/u);
    assert.match(workflow, /security import .*developer-id\.p12/u);
  });

  it("signs, verifies, notarizes, and repackages the Apple Silicon macOS tarball", () => {
    const workflow = readWorkflow();
    const entitlements = fs.readFileSync(
      path.join(process.cwd(), "config/caara.entitlements.plist"),
      "utf8",
    );

    assert.match(workflow, /runs-on: macos-14/u);
    assert.match(workflow, /caara_\$\{VERSION\}_darwin_arm64/u);
    assert.match(
      workflow,
      /codesign --force --deep --sign "\$identity" --timestamp --options runtime --entitlements config\/caara\.entitlements\.plist/u,
    );
    assert.match(workflow, /codesign --verify --deep --strict/u);
    assert.match(workflow, /version_output="\$\("\$BINARY_PATH" --version 2>&1 \|\| true\)"/u);
    assert.match(workflow, /grep -q '\^caara v' <<< "\$version_output"/u);
    for (const entitlement of [
      "allow-jit",
      "allow-unsigned-executable-memory",
      "disable-executable-page-protection",
      "allow-dyld-environment-variables",
      "disable-library-validation",
    ]) {
      assert.match(
        entitlements,
        new RegExp(`<key>com\\.apple\\.security\\.cs\\.${entitlement}</key>\\s*<true/>`, "u"),
      );
    }
    assert.match(
      workflow,
      /op read 'op:\/\/Automation\/Apple Developer App Store Connect AuthKey Github Releases\/AuthKey\.p8'/u,
    );
    assert.match(workflow, /ditto -c -k --keepParent/u);
    assert.match(workflow, /xcrun notarytool submit/u);
    assert.match(workflow, /--key-id "\$APPLE_NOTARY_KEY_ID"/u);
    assert.match(workflow, /--issuer "\$APPLE_NOTARY_ISSUER_ID"/u);
    assert.match(workflow, /tar -czf "dist\/caara_\$\{VERSION\}_darwin_arm64\.tar\.gz"/u);
  });

  it("builds Linux x64 and arm64 tarballs without macOS signing commands", () => {
    const workflow = readWorkflow();
    const linuxJob = workflow.match(/build-linux:[\s\S]*?(?=\n {2}[a-z-]+:|\n$)/u)?.at(0) ?? "";

    assert.match(linuxJob, /runs-on: ubuntu-latest/u);
    assert.match(linuxJob, /linux_amd64/u);
    assert.match(linuxJob, /linux_arm64/u);
    assert.ok(!/codesign|notarytool/u.test(linuxJob));
  });

  it("writes release checksum manifests with asset-local filenames", () => {
    const workflow = readWorkflow();

    assert.match(
      workflow,
      /\(cd dist && shasum -a 256 "caara_\$\{VERSION\}_darwin_arm64\.tar\.gz"\) > "dist\/checksums-darwin_arm64\.txt"/u,
    );
    assert.match(
      workflow,
      /\(cd dist && shasum -a 256 "caara_\$\{VERSION\}_\$\{\{ matrix\.asset \}\}\.tar\.gz"\) > "dist\/checksums-\$\{\{ matrix\.asset \}\}\.txt"/u,
    );
  });

  it("uploads release assets and updates the Homebrew tap cask directly", () => {
    const workflow = readWorkflow();

    assert.match(workflow, /gh release upload "\$\{TAG\}"/u);
    assert.match(workflow, /--clobber/u);
    assert.match(workflow, /dist\/checksums\.txt/u);
    assert.match(workflow, /niieani\/homebrew-tap/u);
    assert.match(workflow, /Casks\/caara\.rb/u);
    assert.match(workflow, /scripts\/writeHomebrewCask\.ts/u);
    assert.match(workflow, /ruby -c .*Casks\/caara\.rb/u);
    assert.match(workflow, /git commit -m "Update caara cask to \$\{VERSION\}"/u);
    assert.match(workflow, /git push/u);
  });
});
