import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { caaraSettingsLayerFromValue, defaultCaaraSettingsValue } from "../caaraSettings.ts";
import { AntigravityCliSettings, antigravityCliSettingsFromEnvironment } from "./settings.ts";

/** Caara settings with stable service path prefixes for Antigravity settings tests. */
const caaraSettingsLayer = caaraSettingsLayerFromValue({
  settings: {
    ...defaultCaaraSettingsValue,
    path: ["/config/bin"],
  },
});

/** Antigravity settings layer with deterministic service-mode environment fixtures. */
const serviceModeSettingsLayer = antigravityCliSettingsFromEnvironment({
  env: {
    CAARA_SERVICE: "1",
    HOME: "/Users/caara",
    PATH: "/ignored/shell/bin",
  },
}).pipe(Layer.provideMerge(caaraSettingsLayer));

describe("Antigravity CLI settings", () => {
  it.effect("uses Caara service-mode execution PATH for child processes", () =>
    Effect.gen(function* () {
      const settings = yield* AntigravityCliSettings;

      assert.strictEqual(settings.homeDir, "/Users/caara");
      assert.strictEqual(
        settings.environment.PATH,
        "/config/bin:/Users/caara/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      );
    }).pipe(Effect.provide(serviceModeSettingsLayer)),
  );
});
