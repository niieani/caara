import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  CaaraSettings,
  defaultCaaraSettingsValue,
  type CaaraSettingsValue,
} from "../caaraSettings.ts";
import { ClaudeAgentSdkSettings, claudeAgentSdkSettingsFromEnvironment } from "./settings.ts";

/** Builds Caara settings with a caller-selected executable search path. */
const caaraSettings = ({ searchPath }: { readonly searchPath: readonly string[] }) =>
  ({
    ...defaultCaaraSettingsValue,
    path: searchPath,
  }) satisfies CaaraSettingsValue;

describe("Claude Agent SDK settings", () => {
  it.effect("resolves the Claude executable from Caara config path prefixes", () => {
    const binDir = path.join(process.cwd(), "temp.local", `claude-settings-${randomUUID()}`, "bin");
    const executablePath = path.join(binDir, "claude");
    const settingsLayer = claudeAgentSdkSettingsFromEnvironment({
      env: {
        CAARA_SERVICE: "1",
        HOME: "/Users/caara",
        PATH: "/ignored/shell/bin",
      },
    }).pipe(
      Layer.provideMerge(Layer.succeed(CaaraSettings, caaraSettings({ searchPath: [binDir] }))),
      Layer.provideMerge(BunServices.layer),
    );

    return Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(binDir, { recursive: true }));
      yield* Effect.promise(() => writeFile(executablePath, "#!/bin/sh\n"));

      const settings = yield* ClaudeAgentSdkSettings;
      const resolvedPath = yield* settings.pathToClaudeCodeExecutable;

      assert.strictEqual(resolvedPath, executablePath);
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("classifies missing Claude executable as invalid_prompt", () => {
    const settingsLayer = claudeAgentSdkSettingsFromEnvironment({
      env: {
        PATH: "",
      },
    }).pipe(
      Layer.provideMerge(Layer.succeed(CaaraSettings, caaraSettings({ searchPath: [] }))),
      Layer.provideMerge(BunServices.layer),
    );

    return Effect.gen(function* () {
      const settings = yield* ClaudeAgentSdkSettings;
      const error = yield* Effect.flip(settings.pathToClaudeCodeExecutable);

      assert.strictEqual(
        error.message,
        "Claude Agent SDK failed to start: command claude is not available on Caara's execution path.",
      );
      assert.strictEqual(error.responseErrorCode, "invalid_prompt");
    }).pipe(Effect.provide(settingsLayer));
  });
});
