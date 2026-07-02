import { Context, Effect, Layer, Option } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  caaraProcessEnvironmentWithExecutionPath,
  pathEntriesFromValue,
  type CaaraExecutionPathEnvironment,
  type CaaraProcessEnvironment,
} from "../caaraExecutionPath.ts";
import { CaaraSettings } from "../caaraSettings.ts";
import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";

/** Configuration needed by the Claude Agent SDK driver to start Claude Code turns. */
export interface ClaudeAgentSdkSettingsValue {
  readonly pathToClaudeCodeExecutable: EffectContract<string, AgentDriverError>;
}

/** Injectable Claude Agent SDK settings used by live code and fake SDK tests. */
export class ClaudeAgentSdkSettings extends Context.Service<
  ClaudeAgentSdkSettings,
  ClaudeAgentSdkSettingsValue
>()("@caara/ClaudeAgentSdkSettings") {}

/** Converts a service configuration error into the driver-facing failure channel. */
const settingsError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Returns candidate absolute executable paths from Caara's effective PATH. */
const claudeExecutableCandidates = ({
  environment,
  pathService,
}: {
  readonly environment: CaaraProcessEnvironment;
  readonly pathService: Path.Path;
}): readonly string[] =>
  pathEntriesFromValue(environment.PATH).map((entry) => pathService.join(entry, "claude"));

/** Resolves the first available Claude executable path from Caara's effective execution path. */
const resolveClaudeExecutablePath = Effect.fnUntraced(function* ({
  environment,
  fileSystem,
  pathService,
}: {
  readonly environment: CaaraProcessEnvironment;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
}) {
  const candidates = claudeExecutableCandidates({ environment, pathService });
  const availability = yield* Effect.forEach(
    candidates,
    (candidate) =>
      fileSystem.access(candidate, { ok: true }).pipe(
        Effect.map(() => candidate),
        Effect.option,
      ),
    { concurrency: "unbounded" },
  );
  const executable = Option.fromUndefinedOr(availability.find(Option.isSome)).pipe(Option.flatten);
  return yield* Option.match(executable, {
    onNone: () =>
      Effect.fail(
        settingsError(
          "Claude Agent SDK failed to start: command claude is not available on Caara's execution path.",
        ),
      ),
    onSome: Effect.succeed,
  });
});

/** Builds live Claude SDK settings from Caara settings and the host process environment. */
export const claudeAgentSdkSettingsFromEnvironment = ({
  env = process.env,
}: {
  readonly env?: CaaraExecutionPathEnvironment;
} = {}) =>
  Layer.effect(
    ClaudeAgentSdkSettings,
    Effect.gen(function* () {
      const caaraSettings = yield* CaaraSettings;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const environment = caaraProcessEnvironmentWithExecutionPath({
        settings: caaraSettings,
        env,
      }).pipe(Effect.mapError((error) => settingsError(error.message)));
      return {
        pathToClaudeCodeExecutable: environment.pipe(
          Effect.flatMap((nextEnvironment) =>
            resolveClaudeExecutablePath({
              environment: nextEnvironment,
              fileSystem,
              pathService,
            }),
          ),
        ),
      } satisfies ClaudeAgentSdkSettingsValue;
    }),
  );
