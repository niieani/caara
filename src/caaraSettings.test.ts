import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  defaultCaaraConfigPath,
  defaultCaaraSettingsValue,
  parseCaaraServiceConfigYaml,
  resolveCaaraSettingsFromArgs,
  type CaaraConfigLoader,
  type CaaraSettingsEnvironment,
  type CaaraSettingsValue,
} from "./caaraSettings.ts";

/** Extracts a failure message from one failed settings result. */
const failureMessage = <A, E extends { readonly message: string }>(
  result: Result.Result<A, E>,
): string =>
  Result.match(result, {
    onFailure: (error) => error.message,
    onSuccess: () => assert.fail("expected Caara settings failure"),
  });

/** Builds an in-memory config loader for settings tests. */
const configLoaderFromFiles = ({
  files,
}: {
  readonly files: Readonly<Record<string, string | undefined>>;
}): CaaraConfigLoader => ({
  read: (configPath) => Effect.succeed(files[configPath]),
});

/** Stable settings test environment with no dependency on the developer shell. */
const testEnv: CaaraSettingsEnvironment = {
  HOME: "/Users/caara",
  XDG_CONFIG_HOME: undefined,
};

/** Stable config paths used by settings tests. */
const testConfigPaths = {
  explicit: "/tmp/caara/config.yaml",
  xdgDefault: "/xdg/config/caara/config.yaml",
} as const;

describe("Caara server settings", () => {
  it.effect("uses defaults when the default config path is absent", () =>
    Effect.gen(function* () {
      const settings = yield* resolveCaaraSettingsFromArgs({
        args: [],
        env: testEnv,
        configLoader: configLoaderFromFiles({ files: {} }),
      });

      assert.strictEqual(
        defaultCaaraConfigPath({ env: testEnv }),
        "/Users/caara/.config/caara/config.yaml",
      );
      assert.deepStrictEqual(settings, defaultCaaraSettingsValue);
    }),
  );

  it.effect("loads YAML config and applies CLI overrides last", () =>
    Effect.gen(function* () {
      const settings = yield* resolveCaaraSettingsFromArgs({
        args: [
          "--config",
          testConfigPaths.explicit,
          "--host",
          "127.0.0.9",
          "--port",
          "8790",
          "--allow-dangerous-skip-permissions",
        ],
        env: testEnv,
        configLoader: configLoaderFromFiles({
          files: {
            [testConfigPaths.explicit]: [
              "host: 0.0.0.0",
              "port: 8788",
              "allowDangerousSkipPermissions: false",
              "path:",
              "  - /opt/caara/bin",
              "logFile: /tmp/caara.log",
              "",
            ].join("\n"),
          },
        }),
      });

      assert.deepStrictEqual(settings, {
        host: "127.0.0.9",
        port: 8790,
        allowDangerousSkipPermissions: true,
        path: ["/opt/caara/bin"],
        logFile: "/tmp/caara.log",
      } satisfies CaaraSettingsValue);
    }),
  );

  it.effect("loads the XDG default config when it exists", () =>
    Effect.gen(function* () {
      const env = {
        HOME: "/Users/caara",
        XDG_CONFIG_HOME: "/xdg/config",
      } satisfies CaaraSettingsEnvironment;
      const settings = yield* resolveCaaraSettingsFromArgs({
        args: [],
        env,
        configLoader: configLoaderFromFiles({
          files: {
            [testConfigPaths.xdgDefault]: "host: 127.0.0.2\nport: 8789\n",
          },
        }),
      });

      assert.deepStrictEqual(settings, {
        ...defaultCaaraSettingsValue,
        host: "127.0.0.2",
        port: 8789,
      } satisfies CaaraSettingsValue);
    }),
  );

  it.effect("fails when an explicit config path is absent", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        resolveCaaraSettingsFromArgs({
          args: ["--config", "/missing/caara.yaml"],
          env: testEnv,
          configLoader: configLoaderFromFiles({ files: {} }),
        }),
      );

      assert.match(
        failureMessage(result),
        /Explicit Caara --config path does not exist.*missing\/caara\.yaml/u,
      );
    }),
  );

  it.effect("rejects malformed, multi-document, unknown-key, and invalid config YAML", () =>
    Effect.gen(function* () {
      const cases = [
        {
          yaml: "host: [",
          expected: /Failed to parse Caara config YAML/u,
        },
        {
          yaml: "---\nhost: 127.0.0.1\n---\nport: 8787\n",
          expected: /must contain exactly one YAML document/u,
        },
        {
          yaml: "extra: true\n",
          expected: /Unknown Caara config key: extra/u,
        },
        {
          yaml: "host: ''\n",
          expected: /host/u,
        },
        {
          yaml: "port: 65536\n",
          expected: /port/u,
        },
        {
          yaml: "path:\n  - relative/bin\n",
          expected: /path entries must be absolute/u,
        },
        {
          yaml: "logFile: relative.log\n",
          expected: /logFile must be absolute/u,
        },
      ] as const;

      for (const testCase of cases) {
        const result = yield* Effect.result(parseCaaraServiceConfigYaml({ yaml: testCase.yaml }));
        assert.match(failureMessage(result), testCase.expected);
      }
    }),
  );

  it.effect("rejects invalid CLI settings explicitly", () =>
    Effect.gen(function* () {
      const missingPort = yield* Effect.result(
        resolveCaaraSettingsFromArgs({
          args: ["--port"],
          env: testEnv,
          configLoader: configLoaderFromFiles({ files: {} }),
        }),
      );
      const nonIntegerPort = yield* Effect.result(
        resolveCaaraSettingsFromArgs({
          args: ["--port", "8787.5"],
          env: testEnv,
          configLoader: configLoaderFromFiles({ files: {} }),
        }),
      );
      const unsupported = yield* Effect.result(
        resolveCaaraSettingsFromArgs({
          args: ["--unknown"],
          env: testEnv,
          configLoader: configLoaderFromFiles({ files: {} }),
        }),
      );

      assert.match(failureMessage(missingPort), /port/u);
      assert.match(failureMessage(nonIntegerPort), /1.*65535/u);
      assert.match(failureMessage(unsupported), /unknown/u);
    }),
  );
});
