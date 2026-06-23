import { Effect, Layer, Match, Option, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type AgentCancellationOutcome,
  AgentDriverError,
  AgentDriverRegistry,
  type AgentDriver,
  type AgentDriverResolve,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentRuntimeEvent,
  unsupportedExternalAgentKindError,
} from "../mockResponsesProvider/agentDriver.ts";
import { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import { antigravityLogFilePath, runAntigravityTurnProcess } from "./cliProcess.ts";
import {
  decodeAntigravityDriverResumeCursor,
  makeAntigravityDriverResumeCursor,
} from "./cursor.ts";
import { parseAntigravityCliOptions, type AntigravityCliOptions } from "./options.ts";
import { extractAntigravityCliPrompt } from "./prompt.ts";
import { AntigravityCliSettings, type AntigravityCliSettingsValue } from "./settings.ts";
import {
  antigravityTranscriptFullPath,
  emptyAntigravityTranscriptObservationState,
  readAntigravityTranscriptObservation,
  readAntigravityTranscriptRuntimeEvents,
  type AntigravityTranscriptObservation,
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

/** Extracts a durable Antigravity resume cursor from prior external session state. */
const durableResumeCursorOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(
    [turn.externalSession]
      .filter((session): session is DurableExternalSession => session?._tag === "Durable")
      .map((session) => session.driverResumeCursor)
      .at(0),
  );

/** Builds a non-reusable terminated cancellation outcome. */
const terminatedCancellationOutcome = (): AgentCancellationOutcome => ({
  _tag: "Terminated",
  sessionReusable: false,
});

/** Builds a reusable interrupted cancellation outcome after a completed recovery start. */
const recoveredCancellationOutcome = (): AgentCancellationOutcome => ({
  _tag: "Interrupted",
  sessionReusable: true,
});

/** Reads runtime events from the transcript owned by one Antigravity conversation id. */
const readRuntimeEventsForConversation = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
  conversationId,
  observation,
  options,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly conversationId: string;
  readonly observation?: AntigravityTranscriptObservation;
  readonly options: AntigravityCliOptions;
}) {
  const transcriptPath = antigravityTranscriptFullPath({
    pathService,
    homeDir: settings.homeDir,
    conversationId,
  });
  return yield* readAntigravityTranscriptRuntimeEvents({
    fileSystem,
    transcriptPath,
    state: observation?.state,
    reasoning: options.reasoning,
    activity: options.activity,
  });
});

/** Builds the common successful Antigravity driver turn result. */
const antigravityTurnResult = ({
  conversationId,
  runtimeEvents,
}: {
  readonly conversationId: string;
  readonly runtimeEvents: readonly AgentRuntimeEvent[];
}): AgentDriverTurnResult => ({
  runtimeEvents: Stream.fromIterable(runtimeEvents),
  externalSession: durableAntigravitySession({ conversationId }),
  cancel: Effect.succeed(terminatedCancellationOutcome()),
});

/** Starts a fresh Antigravity conversation and maps its transcript into runtime events. */
const startFreshAntigravityTurn = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
  spawner,
  turn,
  prompt,
  options,
  logFilePath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly turn: AgentDriverTurn;
  readonly prompt: string;
  readonly options: AntigravityCliOptions;
  readonly logFilePath: string;
}) {
  const conversationId = yield* runAntigravityTurnProcess({
    fileSystem,
    pathService,
    settings,
    spawner,
    turn,
    prompt,
    options,
    logFilePath,
  });
  const runtimeEvents = yield* readRuntimeEventsForConversation({
    fileSystem,
    pathService,
    settings,
    conversationId,
    options,
  });
  return { conversationId, runtimeEvents };
});

/** Starts a fresh Antigravity session after continuity loss and returns recovery metadata. */
const recoverWithFreshAntigravitySession = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
  spawner,
  turn,
  options,
  logFilePath,
  reason,
  diagnostics,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly turn: AgentDriverTurn;
  readonly options: AntigravityCliOptions;
  readonly logFilePath: string;
  readonly reason: string;
  readonly diagnostics: Readonly<Record<string, string>>;
}) {
  const fresh = yield* startFreshAntigravityTurn({
    fileSystem,
    pathService,
    settings,
    spawner,
    turn,
    prompt: lostSessionRecoveryDriverPrompt,
    options,
    logFilePath,
  }).pipe(
    Effect.mapError(
      (error) =>
        new AgentDriverError({
          message: `Antigravity CLI could not preserve Antigravity CLI session continuity or start a fresh external session: ${error.message}`,
        }),
    ),
  );
  return {
    runtimeEvents: Stream.empty,
    externalSession: durableAntigravitySession({ conversationId: fresh.conversationId }),
    bindingCwd: turn.cwd,
    lostSessionRecovery: {
      reason,
      diagnostics,
    },
    cancel: Effect.succeed(recoveredCancellationOutcome()),
  } satisfies AgentDriverTurnResult;
});

/** Reads the transcript state that existed before a resumed Antigravity process is spawned. */
const observePriorResumeTranscript = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
  conversationId,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly conversationId: string;
}) {
  const transcriptPath = antigravityTranscriptFullPath({
    pathService,
    homeDir: settings.homeDir,
    conversationId,
  });
  return yield* readAntigravityTranscriptObservation({
    fileSystem,
    transcriptPath,
    state: emptyAntigravityTranscriptObservationState,
  });
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
    const freshTurn = Effect.map(
      startFreshAntigravityTurn({
        fileSystem,
        pathService,
        settings,
        spawner,
        turn,
        prompt,
        options,
        logFilePath,
      }),
      ({ conversationId, runtimeEvents }) =>
        antigravityTurnResult({ conversationId, runtimeEvents }),
    );

    return yield* Option.match(durableResumeCursorOption(turn), {
      onNone: () => freshTurn,
      onSome: (rawCursor) =>
        Effect.matchEffect(decodeAntigravityDriverResumeCursor(rawCursor), {
          onFailure: (error) =>
            recoverWithFreshAntigravitySession({
              fileSystem,
              pathService,
              settings,
              spawner,
              turn,
              options,
              logFilePath,
              reason: "antigravity-invalid-resume-cursor",
              diagnostics: {
                previousCursor: rawCursor,
                message: error.message,
              },
            }),
          onSuccess: (cursor) =>
            Effect.matchEffect(
              observePriorResumeTranscript({
                fileSystem,
                pathService,
                settings,
                conversationId: cursor.conversationId,
              }),
              {
                onFailure: (error) =>
                  recoverWithFreshAntigravitySession({
                    fileSystem,
                    pathService,
                    settings,
                    spawner,
                    turn,
                    options,
                    logFilePath,
                    reason: "antigravity-invalid-resume-cursor",
                    diagnostics: {
                      previousCursor: cursor.conversationId,
                      message: error.message,
                    },
                  }),
                onSuccess: (observation) =>
                  Effect.matchEffect(
                    runAntigravityTurnProcess({
                      fileSystem,
                      pathService,
                      settings,
                      spawner,
                      turn,
                      prompt,
                      options,
                      logFilePath,
                      conversationId: cursor.conversationId,
                    }),
                    {
                      onFailure: (error) =>
                        recoverWithFreshAntigravitySession({
                          fileSystem,
                          pathService,
                          settings,
                          spawner,
                          turn,
                          options,
                          logFilePath,
                          reason: "antigravity-resume-failed",
                          diagnostics: {
                            previousCursor: cursor.conversationId,
                            message: error.message,
                          },
                        }),
                      onSuccess: () =>
                        Effect.map(
                          readRuntimeEventsForConversation({
                            fileSystem,
                            pathService,
                            settings,
                            conversationId: cursor.conversationId,
                            observation,
                            options,
                          }),
                          (runtimeEvents) =>
                            antigravityTurnResult({
                              conversationId: cursor.conversationId,
                              runtimeEvents,
                            }),
                        ),
                    },
                  ),
              },
            ),
        }),
    });
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
