import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Path from "effect/Path";

import { defaultCaaraSettingsValue, type CaaraSettingsValue } from "../caaraSettings.ts";
import type { CodexSandboxPosture } from "../mockResponsesProvider/codexTurnContext.ts";
import { buildAntigravityCliArgv, parseAntigravityCliOptions } from "./options.ts";

/** Caara settings used when explicit skip-permission tests allow dangerous bypass. */
const dangerousCaaraSettings: CaaraSettingsValue = {
  ...defaultCaaraSettingsValue,
  allowDangerousSkipPermissions: true,
};

/** One invalid option parser case and its expected failure text. */
interface InvalidOptionCase {
  readonly name: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly expected: string;
}

/** Invalid Antigravity option cases that must fail before the CLI is spawned. */
const invalidOptionCases: readonly InvalidOptionCase[] = [
  {
    name: "raw flags",
    rawDriverOptions: { raw_flags: "--help" },
    expected: "Unsupported Antigravity driver option: raw_flags.",
  },
  {
    name: "empty model",
    rawDriverOptions: { model: "" },
    expected: "model must be non-empty.",
  },
  {
    name: "sandbox boolean",
    rawDriverOptions: { sandbox: "yes" },
    expected: "sandbox must be true or false.",
  },
  {
    name: "untrusted permission skip",
    rawDriverOptions: { dangerously_skip_permissions: "true" },
    expected:
      "Antigravity --dangerously-skip-permissions requires --allow-dangerous-skip-permissions.",
  },
  {
    name: "print timeout lower bound",
    rawDriverOptions: { print_timeout_seconds: "0" },
    expected: "print_timeout_seconds must be an integer from 1 to 86400.",
  },
  {
    name: "print timeout upper bound",
    rawDriverOptions: { print_timeout_seconds: "86401" },
    expected: "print_timeout_seconds must be an integer from 1 to 86400.",
  },
  {
    name: "relative add dir",
    rawDriverOptions: { add_dirs: `["relative"]` },
    expected: "add_dirs must be an absolute path.",
  },
  {
    name: "non-array add dirs",
    rawDriverOptions: { add_dirs: "{}" },
    expected: "add_dirs must be a JSON array of non-empty absolute paths.",
  },
  {
    name: "relative log file",
    rawDriverOptions: { log_file: "relative.log" },
    expected: "log_file must be an absolute path.",
  },
  {
    name: "reasoning mode",
    rawDriverOptions: { reasoning: "maybe" },
    expected: "reasoning must be on or off.",
  },
  {
    name: "activity mode",
    rawDriverOptions: { activity: "maybe" },
    expected: "activity must be on or off.",
  },
];

/** Parses Antigravity options with the default Path service. */
const parseOptions = ({
  rawDriverOptions,
  sandboxPosture,
  caaraSettings = defaultCaaraSettingsValue,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly sandboxPosture?: CodexSandboxPosture;
  readonly caaraSettings?: CaaraSettingsValue;
}) =>
  Effect.gen(function* () {
    const pathService = yield* Path.Path;
    return yield* parseAntigravityCliOptions({
      caaraSettings,
      externalModelSpecifier: "gemini-3.5-flash",
      rawDriverOptions,
      sandboxPosture,
      pathService,
    });
  }).pipe(Effect.provide(Path.layer));

describe("Antigravity CLI options", () => {
  it.effect("parses configured options and builds exact agy argv", () =>
    Effect.gen(function* () {
      const addDirs = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([
        "/tmp/one",
        "/tmp/two",
      ]);
      const options = yield* parseOptions({
        caaraSettings: dangerousCaaraSettings,
        rawDriverOptions: {
          model: "gemini-3.5-pro",
          print_timeout_seconds: "900",
          sandbox: "true",
          add_dirs: addDirs,
          log_file: "/tmp/agy-driver.log",
          dangerously_skip_permissions: "true",
          reasoning: "off",
          activity: "off",
        },
      });

      assert.deepStrictEqual(
        buildAntigravityCliArgv({
          prompt: "turn turn-1",
          options,
          logFilePath: "/tmp/default.log",
        }),
        [
          "--prompt",
          "turn turn-1",
          "--model",
          "gemini-3.5-pro",
          "--print-timeout",
          "900s",
          "--sandbox",
          "--dangerously-skip-permissions",
          "--add-dir",
          "/tmp/one",
          "--add-dir",
          "/tmp/two",
          "--log-file",
          "/tmp/agy-driver.log",
        ],
      );
    }),
  );

  it.effect("defaults print timeout to two hours and accepts explicit twenty four hours", () =>
    Effect.gen(function* () {
      const defaultOptions = yield* parseOptions({
        rawDriverOptions: {},
      });
      const maximumOptions = yield* parseOptions({
        rawDriverOptions: { print_timeout_seconds: "86400" },
      });

      assert.strictEqual(defaultOptions.printTimeoutSeconds, 7200);
      assert.deepStrictEqual(
        buildAntigravityCliArgv({
          prompt: "turn turn-1",
          options: defaultOptions,
          logFilePath: "/tmp/default.log",
        }).slice(4, 6),
        ["--print-timeout", "7200s"],
      );
      assert.strictEqual(maximumOptions.printTimeoutSeconds, 86400);
      assert.deepStrictEqual(
        buildAntigravityCliArgv({
          prompt: "turn turn-1",
          options: maximumOptions,
          logFilePath: "/tmp/default.log",
        }).slice(4, 6),
        ["--print-timeout", "86400s"],
      );
    }),
  );

  it.effect("uses enforced Codex sandbox posture as the Antigravity sandbox fallback", () =>
    Effect.gen(function* () {
      const options = yield* parseOptions({
        rawDriverOptions: {},
        sandboxPosture: "enforced",
      });
      const argv = buildAntigravityCliArgv({
        prompt: "turn turn-1",
        options,
        logFilePath: "/tmp/default.log",
      });

      assert.strictEqual(options.sandbox, true);
      assert.strictEqual(argv.includes("--sandbox"), true);
    }),
  );

  it.effect(
    "keeps no-sandbox Codex posture and missing advisory posture unsandboxed by default",
    () =>
      Effect.gen(function* () {
        const noSandboxOptions = yield* parseOptions({
          rawDriverOptions: {},
          sandboxPosture: "none",
        });
        const missingAdvisoryOptions = yield* parseOptions({
          rawDriverOptions: {},
        });

        assert.strictEqual(noSandboxOptions.sandbox, false);
        assert.strictEqual(missingAdvisoryOptions.sandbox, false);
        assert.strictEqual(
          buildAntigravityCliArgv({
            prompt: "turn turn-1",
            options: noSandboxOptions,
            logFilePath: "/tmp/default.log",
          }).includes("--sandbox"),
          false,
        );
      }),
  );

  it.effect("keeps Antigravity sandbox query options above Codex sandbox posture", () =>
    Effect.gen(function* () {
      const explicitFalse = yield* parseOptions({
        rawDriverOptions: { sandbox: "false" },
        sandboxPosture: "enforced",
      });
      const explicitTrue = yield* parseOptions({
        rawDriverOptions: { sandbox: "true" },
        sandboxPosture: "none",
      });

      assert.strictEqual(explicitFalse.sandbox, false);
      assert.strictEqual(explicitTrue.sandbox, true);
    }),
  );

  it.effect("rejects invalid sandbox query options even with advisory posture present", () =>
    Effect.gen(function* () {
      const failure = yield* parseOptions({
        rawDriverOptions: { sandbox: "yes" },
        sandboxPosture: "enforced",
      }).pipe(Effect.flip);

      assert.strictEqual(failure.message, "sandbox must be true or false.");
      assert.strictEqual(failure.responseErrorCode, "invalid_prompt");
    }),
  );

  for (const testCase of invalidOptionCases) {
    it.effect(`rejects invalid ${testCase.name} option`, () =>
      Effect.gen(function* () {
        const failure = yield* parseOptions({
          rawDriverOptions: testCase.rawDriverOptions,
        }).pipe(Effect.flip);

        assert.strictEqual(failure.message, testCase.expected);
        assert.strictEqual(failure.responseErrorCode, "invalid_prompt");
      }),
    );
  }
});
