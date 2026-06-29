import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { defaultCaaraSettingsValue, type CaaraConfigLoader } from "./caaraSettings.ts";
import { caaraHealthProbeUrl, runCaaraStatus, type CaaraHealthProbe } from "./caaraStatus.ts";

/** Stable settings test environment with no dependency on the developer shell. */
const testEnv = {
  HOME: "/Users/caara",
  XDG_CONFIG_HOME: undefined,
} as const;

/** Config loader with no files, so status uses built-in defaults plus CLI overrides. */
const emptyConfigLoader: CaaraConfigLoader = {
  read: () => Effect.map(Effect.void, (): string | undefined => undefined),
};

/** Health probe that always reports a live Caara router. */
const healthyProbe: CaaraHealthProbe = {
  probe: () => Effect.succeed({ status: "ok", service: "caara" }),
};

describe("Caara status command", () => {
  it.effect("reports healthy status for the resolved health URL", () =>
    Effect.gen(function* () {
      const result = yield* runCaaraStatus({
        args: ["--host", "127.0.0.2", "--port", "8799"],
        configLoader: emptyConfigLoader,
        env: testEnv,
        probe: healthyProbe,
      });

      assert.deepStrictEqual(result, {
        exitCode: 0,
        message: "Caara healthy at http://127.0.0.2:8799/health",
        url: "http://127.0.0.2:8799/health",
      });
    }),
  );

  it.effect("returns nonzero status for an unreachable live port", () =>
    Effect.gen(function* () {
      const result = yield* runCaaraStatus({
        args: ["--host", "127.0.0.1", "--port", "65534"],
        configLoader: emptyConfigLoader,
        env: testEnv,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.url, "http://127.0.0.1:65534/health");
      assert.match(result.message, /Caara unhealthy/u);
    }),
  );

  it("maps bind-all hosts to loopback probe URLs", () => {
    assert.strictEqual(
      caaraHealthProbeUrl({
        settings: {
          ...defaultCaaraSettingsValue,
          host: "0.0.0.0",
          port: 8799,
        },
      }),
      "http://127.0.0.1:8799/health",
    );
    assert.strictEqual(
      caaraHealthProbeUrl({
        settings: {
          ...defaultCaaraSettingsValue,
          host: "::",
          port: 8799,
        },
      }),
      "http://[::1]:8799/health",
    );
  });
});
