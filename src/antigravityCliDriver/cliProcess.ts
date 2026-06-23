import { Effect, Match, Option } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { AgentDriverError, type AgentDriverTurn } from "../mockResponsesProvider/agentDriver.ts";
import { buildAntigravityCliArgv, type AntigravityCliOptions } from "./options.ts";
import type { AntigravityCliSettingsValue } from "./settings.ts";

/** Builds the Antigravity CLI diagnostic log-file path for one Codex turn. */
export const antigravityLogFilePath = ({
  pathService,
  homeDir,
  turn,
}: {
  readonly pathService: Path.Path;
  readonly homeDir: string;
  readonly turn: AgentDriverTurn;
}): string =>
  pathService.join(homeDir, ".caara", "antigravity-cli", "logs", `${turn.codex.turnId}.log`);

/** Extracts the Antigravity conversation id from the CLI log content. */
const conversationIdFromLog = Effect.fnUntraced(function* (content: string) {
  const match =
    /Created conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu.exec(
      content,
    );
  const conversationId = match?.[1];
  return yield* Match.value(conversationId).pipe(
    Match.when(undefined, () =>
      Effect.fail(
        new AgentDriverError({
          message: "Antigravity CLI log did not contain a created conversation id.",
        }),
      ),
    ),
    Match.orElse((id) => Effect.succeed(id)),
  );
});

/** Reads the Antigravity CLI log file or fails with a driver-owned startup error. */
const readAntigravityLogFile = Effect.fnUntraced(function* ({
  fileSystem,
  logFilePath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly logFilePath: string;
}) {
  return yield* fileSystem.readFileString(logFilePath).pipe(
    Effect.mapError(
      () =>
        new AgentDriverError({
          message: "Antigravity CLI log file was not created.",
        }),
    ),
  );
});

/** Creates the parent directory for one driver-owned Antigravity diagnostic log file. */
const makeAntigravityLogDirectory = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  logFilePath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly logFilePath: string;
}) {
  return yield* fileSystem
    .makeDirectory(pathService.dirname(logFilePath), { recursive: true })
    .pipe(
      Effect.mapError(
        (error) =>
          new AgentDriverError({
            message: `Could not create Antigravity diagnostic log directory: ${error.message}`,
          }),
      ),
    );
});

/** Returns true when a configured command should be resolved as a filesystem path. */
const isPathCommand = ({
  command,
  pathService,
}: {
  readonly command: string;
  readonly pathService: Path.Path;
}): boolean => command.includes(pathService.sep) || pathService.isAbsolute(command);

/** Returns candidate executable paths for one bare command name from the active PATH. */
const pathCommandCandidates = ({
  command,
  pathService,
  settings,
}: {
  readonly command: string;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
}): readonly string[] =>
  (settings.environment.PATH ?? process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0)
    .map((entry) => pathService.join(entry, command));

/** Fails explicitly before spawning when the configured Antigravity command is unavailable. */
const ensureAntigravityCommandAvailable = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
}) {
  const candidates = Match.value(isPathCommand({ command: settings.command, pathService })).pipe(
    Match.when(true, () => [settings.command]),
    Match.orElse(() => pathCommandCandidates({ command: settings.command, pathService, settings })),
  );
  const availability = yield* Effect.forEach(
    candidates,
    (candidate) =>
      fileSystem.access(candidate, { ok: true }).pipe(
        Effect.map(() => candidate),
        Effect.option,
      ),
    { concurrency: "unbounded" },
  );
  const executable = availability.find(Option.isSome);
  return yield* Option.match(Option.fromUndefinedOr(executable), {
    onNone: () =>
      Effect.fail(
        new AgentDriverError({
          message: `Antigravity CLI failed to start: command ${settings.command} is not available.`,
        }),
      ),
    onSome: () => Effect.void,
  });
});

/** Runs one Antigravity CLI process and returns its exit code. */
const runAntigravityProcess = Effect.fnUntraced(function* ({
  settings,
  spawner,
  turn,
  argv,
}: {
  readonly settings: AntigravityCliSettingsValue;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly turn: AgentDriverTurn;
  readonly argv: readonly string[];
}) {
  const command = ChildProcess.make(settings.command, argv, {
    cwd: turn.cwd,
    env: {
      ...settings.environment,
      HOME: settings.homeDir,
    },
    extendEnv: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = yield* spawner.exitCode(command).pipe(
    Effect.mapError(
      (error) =>
        new AgentDriverError({
          message: `Antigravity CLI failed to start: ${error.message}`,
        }),
    ),
  );
  return yield* Match.value(Number(exitCode)).pipe(
    Match.when(0, () => Effect.void),
    Match.orElse((code) =>
      Effect.fail(
        new AgentDriverError({
          message: `Antigravity CLI exited with code ${code}.`,
        }),
      ),
    ),
  );
});

/** Runs one Antigravity CLI process and returns the active conversation id. */
export const runAntigravityTurnProcess = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
  spawner,
  turn,
  prompt,
  options,
  logFilePath,
  conversationId,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly turn: AgentDriverTurn;
  readonly prompt: string;
  readonly options: AntigravityCliOptions;
  readonly logFilePath: string;
  readonly conversationId?: string;
}) {
  yield* makeAntigravityLogDirectory({ fileSystem, pathService, logFilePath });
  yield* ensureAntigravityCommandAvailable({ fileSystem, pathService, settings });
  yield* runAntigravityProcess({
    settings,
    spawner,
    turn,
    argv: buildAntigravityCliArgv({ prompt, options, logFilePath, conversationId }),
  });
  return yield* Option.match(Option.fromUndefinedOr(conversationId), {
    onNone: () =>
      Effect.gen(function* () {
        const logContent = yield* readAntigravityLogFile({ fileSystem, logFilePath });
        return yield* conversationIdFromLog(logContent);
      }),
    onSome: Effect.succeed,
  });
});
