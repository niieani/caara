import { Effect, Exit, Match, Option, Schedule, Scope } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { AgentDriverError, type AgentDriverTurn } from "../mockResponsesProvider/agentDriver.ts";
import { buildAntigravityCliArgv, type AntigravityCliOptions } from "./options.ts";
import type { AntigravityCliSettingsValue } from "./settings.ts";

/** Live Antigravity process controls owned by one driver turn. */
export interface AntigravityRunningProcess {
  readonly conversationId: string;
  readonly awaitExit: EffectContract<void, AgentDriverError>;
  readonly terminate: EffectContract<void, AgentDriverError>;
  readonly close: EffectContract<void>;
}

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

/** Reads and parses one Antigravity conversation id from the diagnostic log file. */
const readConversationIdFromLogFile = Effect.fnUntraced(function* ({
  fileSystem,
  logFilePath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly logFilePath: string;
}) {
  const logContent = yield* readAntigravityLogFile({ fileSystem, logFilePath });
  return yield* conversationIdFromLog(logContent);
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

/** Builds the configured Antigravity child-process command. */
const antigravityProcessCommand = ({
  settings,
  turn,
  argv,
}: {
  readonly settings: AntigravityCliSettingsValue;
  readonly turn: AgentDriverTurn;
  readonly argv: readonly string[];
}) =>
  ChildProcess.make(settings.command, argv, {
    cwd: turn.cwd,
    env: {
      ...settings.environment,
      HOME: settings.homeDir,
    },
    extendEnv: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    killSignal: "SIGTERM",
    forceKillAfter: "1 second",
  });

/** Validates that one Antigravity process exited successfully. */
const validateAntigravityExitCode = (exitCode: unknown): EffectContract<void, AgentDriverError> =>
  Match.value(Number(exitCode)).pipe(
    Match.when(0, () => Effect.void),
    Match.orElse((code) =>
      Effect.fail(
        new AgentDriverError({
          message: `Antigravity CLI exited with code ${code}.`,
        }),
      ),
    ),
  );

/** Closes one live Antigravity process scope. */
const closeAntigravityProcessScope = (scope: Scope.Closeable): EffectContract<void> =>
  Scope.close(scope, Exit.void).pipe(Effect.ignore);

/** Waits for one Antigravity process to exit and validates its exit status. */
const antigravityProcessExit = ({
  handle,
}: {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
}) =>
  handle.exitCode.pipe(
    Effect.mapError(
      (error) =>
        new AgentDriverError({
          message: `Antigravity CLI failed to start: ${error.message}`,
        }),
    ),
    Effect.flatMap(validateAntigravityExitCode),
  );

/** Terminates a live Antigravity process and closes its process scope. */
const terminateAntigravityProcess = ({
  handle,
  close,
}: {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly close: EffectContract<void>;
}) =>
  handle.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(
    Effect.mapError(
      (error) =>
        new AgentDriverError({
          message: `Antigravity CLI could not be terminated: ${error.message}`,
        }),
    ),
    Effect.ensuring(close),
  );

/** Waits for a fresh Antigravity process to reveal its conversation id or fail first. */
const waitForFreshConversationId = ({
  fileSystem,
  logFilePath,
  processExit,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly logFilePath: string;
  readonly processExit: EffectContract<void, AgentDriverError>;
}) => {
  const waitForLog = readConversationIdFromLogFile({ fileSystem, logFilePath }).pipe(
    Effect.retry(Schedule.spaced("20 millis")),
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap((conversationId) =>
      Option.match(conversationId, {
        onNone: () =>
          Effect.fail(
            new AgentDriverError({
              message: "Antigravity CLI log file was not created.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
  const readLogAfterCleanExit = processExit.pipe(
    Effect.flatMap(() => readConversationIdFromLogFile({ fileSystem, logFilePath })),
  );
  return Effect.raceFirst(waitForLog, readLogAfterCleanExit);
};

/** Starts one Antigravity CLI process and returns live process controls. */
export const startAntigravityTurnProcess = Effect.fnUntraced(function* ({
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
  const command = antigravityProcessCommand({
    settings,
    turn,
    argv: buildAntigravityCliArgv({ prompt, options, logFilePath, conversationId }),
  });
  const scope = yield* Scope.make();
  const close = closeAntigravityProcessScope(scope);
  const handle = yield* spawner.spawn(command).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.mapError(
      (error) =>
        new AgentDriverError({
          message: `Antigravity CLI failed to start: ${error.message}`,
        }),
    ),
  );
  const processExit = antigravityProcessExit({ handle });
  const awaitExit = processExit.pipe(Effect.ensuring(close));
  const activeConversationIdEffect = Option.match(Option.fromUndefinedOr(conversationId), {
    onNone: () => waitForFreshConversationId({ fileSystem, logFilePath, processExit }),
    onSome: Effect.succeed,
  });
  const activeConversationId = yield* activeConversationIdEffect.pipe(
    Effect.catch((error: AgentDriverError) =>
      Effect.gen(function* () {
        yield* close;
        return yield* error;
      }),
    ),
  );
  return {
    conversationId: activeConversationId,
    awaitExit,
    terminate: terminateAntigravityProcess({ handle, close }),
    close,
  } satisfies AntigravityRunningProcess;
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
  const running = yield* startAntigravityTurnProcess({
    fileSystem,
    pathService,
    settings,
    spawner,
    turn,
    prompt,
    options,
    logFilePath,
    conversationId,
  });
  yield* running.awaitExit;
  return running.conversationId;
});
