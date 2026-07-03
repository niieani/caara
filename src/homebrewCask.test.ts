import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createHomebrewCaskDefinition,
  renderValidatedHomebrewCask,
  validateHomebrewCaskText,
} from "./homebrewCask.ts";

/** Builds deterministic release checksums for cask rendering tests. */
const releaseChecksums = () =>
  [
    {
      path: "dist/caara_1.2.3_darwin_arm64.tar.gz",
      sha256: "a".repeat(64),
    },
    {
      path: "dist/caara_1.2.3_linux_amd64.tar.gz",
      sha256: "b".repeat(64),
    },
    {
      path: "dist/caara_1.2.3_linux_arm64.tar.gz",
      sha256: "c".repeat(64),
    },
  ] as const;

/** Renders the standard cask fixture used by assertions. */
const renderFixtureCask = Effect.fnUntraced(function* () {
  const definition = yield* createHomebrewCaskDefinition({
    checksums: releaseChecksums(),
    repository: "niieani/caara",
    version: "1.2.3",
  });
  return yield* renderValidatedHomebrewCask({ definition });
});

describe("Homebrew cask generation", () => {
  it.effect("references versioned release tarballs and checksums for every public artifact", () =>
    Effect.gen(function* () {
      const cask = yield* renderFixtureCask();

      assert.match(
        cask,
        /https:\/\/github\.com\/niieani\/caara\/releases\/download\/v1\.2\.3\/caara_1\.2\.3_darwin_arm64\.tar\.gz/u,
      );
      assert.match(
        cask,
        /https:\/\/github\.com\/niieani\/caara\/releases\/download\/v1\.2\.3\/caara_1\.2\.3_linux_amd64\.tar\.gz/u,
      );
      assert.match(
        cask,
        /https:\/\/github\.com\/niieani\/caara\/releases\/download\/v1\.2\.3\/caara_1\.2\.3_linux_arm64\.tar\.gz/u,
      );
      assert.match(cask, new RegExp(`sha256 "${"a".repeat(64)}"`, "u"));
      assert.match(cask, new RegExp(`sha256 "${"b".repeat(64)}"`, "u"));
      assert.match(cask, new RegExp(`sha256 "${"c".repeat(64)}"`, "u"));
    }),
  );

  it.effect(
    "installs the binary and delegates service lifecycle without destructive uninstall",
    () =>
      Effect.gen(function* () {
        const cask = yield* renderFixtureCask();

        assert.match(cask, /binary "caara"/u);
        assert.match(cask, /postflight do[\s\S]*args: \["install-service"\]/u);
        assert.match(cask, /uninstall_preflight do[\s\S]*args: \["uninstall-service"\]/u);
        assert.ok(!/uninstall-service", "--purge/u.test(cask));
        assert.match(cask, /zap trash: \[/u);
        assert.match(cask, /~\/\.config\/caara/u);
        assert.match(cask, /~\/\.local\/state\/caara/u);
      }),
  );

  it.effect("encodes Apple Silicon macOS only plus Linux x64 and arm64 selection", () =>
    Effect.gen(function* () {
      const cask = yield* renderFixtureCask();

      assert.match(cask, /OS\.mac\? && Hardware::CPU\.arm\?/u);
      assert.match(cask, /OS\.linux\? && Hardware::CPU\.intel\?/u);
      assert.match(cask, /OS\.linux\? && Hardware::CPU\.arm\?/u);
      assert.ok(!/darwin_amd64|darwin_x64|bun-darwin-x64/u.test(cask));
    }),
  );

  it.effect("validates generated cask syntax and fails hard for malformed text", () =>
    Effect.gen(function* () {
      const cask = yield* renderFixtureCask();
      const valid = yield* Effect.result(validateHomebrewCaskText({ caskText: cask }));
      const malformed = yield* Effect.result(
        validateHomebrewCaskText({ caskText: 'cask "caara" do\n  version "1.2.3"\n' }),
      );

      assert.strictEqual(valid._tag, "Success");
      assert.strictEqual(malformed._tag, "Failure");
    }),
  );
});
