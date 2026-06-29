import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { resolveCaaraExecutionPath } from "./caaraExecutionPath.ts";
import { defaultCaaraSettingsValue, type CaaraSettingsValue } from "./caaraSettings.ts";

/** Builds Caara settings with stable path prefixes for execution-path tests. */
const settingsWithPath = ({
  path = ["/config/bin"],
}: {
  readonly path?: readonly string[];
} = {}): CaaraSettingsValue => ({
  ...defaultCaaraSettingsValue,
  path,
});

describe("Caara execution path", () => {
  it.effect("prepends config path prefixes to inherited PATH for foreground runs", () =>
    Effect.gen(function* () {
      const effectivePath = yield* resolveCaaraExecutionPath({
        settings: settingsWithPath(),
        env: {
          HOME: "/Users/caara",
          PATH: "/shell/bin:/usr/bin",
        },
      });

      assert.strictEqual(effectivePath, "/config/bin:/shell/bin:/usr/bin");
    }),
  );

  it.effect("uses deterministic built-in defaults instead of inherited PATH in service mode", () =>
    Effect.gen(function* () {
      const effectivePath = yield* resolveCaaraExecutionPath({
        settings: settingsWithPath(),
        env: {
          CAARA_SERVICE: "1",
          HOME: "/Users/caara",
          PATH: "/ignored/shell/bin",
        },
      });

      assert.strictEqual(
        effectivePath,
        "/config/bin:/Users/caara/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      );
    }),
  );
});
