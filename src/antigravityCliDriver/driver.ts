import { Effect, Layer, Match, Option, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentDriver,
  type AgentDriverResolve,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  unsupportedExternalAgentKindError,
} from "../mockResponsesProvider/agentDriver.ts";
import { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
import { makeAntigravityDriverResumeCursor } from "./cursor.ts";
import { buildAntigravityCliArgv, parseAntigravityCliOptions } from "./options.ts";
import { extractAntigravityCliPrompt } from "./prompt.ts";
import { AntigravityCliSettings, type AntigravityCliSettingsValue } from "./settings.ts";
import {
  antigravityTranscriptFullPath,
  readAntigravityTranscriptRuntimeEvents,
} from "./transcript.ts";

/** Builds a durable Caara session from an Antigravity conversation id. */
const durableAntigravitySession = ({
  conversationId,
}: {
  readonly conversationId: string;
}): DurableExternalSession =>
  new DurableExternalSession({
    driverResumeCursor: makeAntigravityDriverResumeCursor({ conversationId }),
  });

/** Builds the Antigravity CLI diagnostic log-file path for one Codex turn. */
const antigravityLogFilePath = ({
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

/** Fails explicitly before spawning when the configured Antigravity command is not executable. */
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

/** Creates a driver implementation from injected Antigravity process/filesystem services. */
export const makeAntigravityCliAgentDriver = ({
  settings,
  fileSystem,
  pathService,
  spawner,
}: {
  readonly settings: AntigravityCliSettingsValue;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): AgentDriver => ({
  startOrResumeTurn: Effect.fnUntraced(function* (turn: AgentDriverTurn) {
    const prompt = yield* extractAntigravityCliPrompt(turn.prompt);
    const options = yield* parseAntigravityCliOptions({
      externalModelSpecifier: turn.target.externalModelSpecifier,
      rawDriverOptions: turn.target.rawDriverOptions,
      pathService,
      settings,
    });
    const defaultLogFilePath = antigravityLogFilePath({
      pathService,
      homeDir: settings.homeDir,
      turn,
    });
    const logFilePath = options.logFile ?? defaultLogFilePath;
    yield* fileSystem.makeDirectory(pathService.dirname(logFilePath), { recursive: true }).pipe(
      Effect.mapError(
        (error) =>
          new AgentDriverError({
            message: `Could not create Antigravity diagnostic log directory: ${error.message}`,
          }),
      ),
    );

    yield* ensureAntigravityCommandAvailable({ fileSystem, pathService, settings });
    yield* runAntigravityProcess({
      settings,
      spawner,
      turn,
      argv: buildAntigravityCliArgv({ prompt, options, logFilePath }),
    });
    const logContent = yield* readAntigravityLogFile({ fileSystem, logFilePath });
    const conversationId = yield* conversationIdFromLog(logContent);
    const transcriptPath = antigravityTranscriptFullPath({
      pathService,
      homeDir: settings.homeDir,
      conversationId,
    });
    const runtimeEvents = yield* readAntigravityTranscriptRuntimeEvents({
      fileSystem,
      transcriptPath,
    });

    return {
      runtimeEvents: Stream.fromIterable(runtimeEvents),
      externalSession: durableAntigravitySession({ conversationId }),
      cancel: Effect.succeed({
        _tag: "Terminated",
        sessionReusable: false,
      }),
    } satisfies AgentDriverTurnResult;
  }),
});

/** Registry layer that routes `agy` targets to the Antigravity CLI driver. */
export const antigravityCliDriverLayer = Layer.effect(
  AgentDriverRegistry,
  Effect.gen(function* () {
    const settings = yield* AntigravityCliSettings;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const driver = makeAntigravityCliAgentDriver({
      settings,
      fileSystem,
      pathService,
      spawner,
    });
    const resolve: AgentDriverResolve = (target) =>
      Match.value(target.externalAgentKind).pipe(
        Match.when("agy", () => Effect.succeed(driver)),
        Match.orElse((externalAgentKind) =>
          Effect.fail(unsupportedExternalAgentKindError({ externalAgentKind })),
        ),
      );
    return { resolve };
  }),
);
