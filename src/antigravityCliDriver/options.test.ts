import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Path from "effect/Path";

import { buildAntigravityCliArgv, parseAntigravityCliOptions } from "./options.ts";
import type { AntigravityCliSettingsValue } from "./settings.ts";

/** Untrusted Antigravity CLI settings used by default option parser tests. */
const untrustedSettings: AntigravityCliSettingsValue = {
  command: "agy",
  homeDir: "/tmp/agy-home",
  allowDangerousSkipPermissions: false,
  environment: {},
};

/** Trusted Antigravity CLI settings used only for explicit skip-permission tests. */
const trustedSettings: AntigravityCliSettingsValue = {
  ...untrustedSettings,
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
    expected: "Antigravity --dangerously-skip-permissions requires trusted driver configuration.",
  },
  {
    name: "print timeout lower bound",
    rawDriverOptions: { print_timeout_seconds: "0" },
    expected: "print_timeout_seconds must be an integer from 1 to 7200.",
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
  settings = untrustedSettings,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly settings?: AntigravityCliSettingsValue;
}) =>
  Effect.gen(function* () {
    const pathService = yield* Path.Path;
    return yield* parseAntigravityCliOptions({
      externalModelSpecifier: "gemini-3.5-flash",
      rawDriverOptions,
      pathService,
      settings,
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
        settings: trustedSettings,
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

  for (const testCase of invalidOptionCases) {
    it.effect(`rejects invalid ${testCase.name} option`, () =>
      Effect.gen(function* () {
        const failure = yield* parseOptions({
          rawDriverOptions: testCase.rawDriverOptions,
        }).pipe(Effect.flip);

        assert.ok(failure.message.includes(testCase.expected), failure.message);
      }),
    );
  }
});
