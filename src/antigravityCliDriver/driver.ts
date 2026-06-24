import { Effect, Layer, Match, Option, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type AgentDriverCancel,
  type AgentCancellationOutcome,
  AgentDriverError,
  AgentDriverRegistry,
  type AgentDriver,
  type AgentDriverResolve,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentRuntimeEventStream,
  unsupportedExternalAgentKindError,
} from "../mockResponsesProvider/agentDriver.ts";
import { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import {
  antigravityLogFilePath,
  runAntigravityTurnProcess,
  startAntigravityTurnProcess,
  type AntigravityRunningProcess,
} from "./cliProcess.ts";
import {
  decodeAntigravityDriverResumeCursor,
  makeAntigravityDriverResumeCursor,
} from "./cursor.ts";
import {
  failOnImmediateResumeExit,
  forkAntigravityProcessExit,
  runtimeEventsFromProcessExitFiber,
  runtimeEventsFromRunningProcess,
  transcriptPathForConversation,
} from "./liveRuntimeEvents.ts";
import { parseAntigravityCliOptions, type AntigravityCliOptions } from "./options.ts";
import { extractAntigravityCliPrompt } from "./prompt.ts";
import { AntigravityCliSettings, type AntigravityCliSettingsValue } from "./settings.ts";
import {
  antigravityTranscriptFullPath,
  emptyAntigravityTranscriptObservationState,
  readAntigravityTranscriptObservation,
  type AntigravityTranscriptObservation,
  type AntigravityTranscriptTelemetryContext,
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

/** Builds safe transcript warning correlation metadata from one Codex driver turn. */
const transcriptTelemetryContextFromTurn = (
  turn: AgentDriverTurn,
): AntigravityTranscriptTelemetryContext => ({
  threadId: turn.codex.threadId,
  turnId: turn.codex.turnId,
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

/** Builds a reusable interrupted cancellation outcome. */
const interruptedCancellationOutcome = (): AgentCancellationOutcome => ({
  _tag: "Interrupted",
  sessionReusable: true,
});

/** Returns cancellation outcome from the conservative transcript mutation proof. */
const cancellationOutcomeFromTranscriptContent = (hasTranscriptContent: boolean) =>
  Match.value(hasTranscriptContent).pipe(
    Match.when(true, terminatedCancellationOutcome),
    Match.orElse(interruptedCancellationOutcome),
  );

/** Returns true when the transcript path has any bytes, including an incomplete JSONL tail. */
const transcriptHasContent = Effect.fnUntraced(function* ({
  fileSystem,
  transcriptPath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
}) {
  const content = yield* fileSystem.readFileString(transcriptPath).pipe(Effect.option);
  return Option.match(content, {
    onNone: () => false,
    onSome: (text) => text.length > 0,
  });
});

/** Cancels one live fresh Antigravity process and reports conservative binding reusability. */
const cancelRunningAntigravityTurn = ({
  fileSystem,
  transcriptPath,
  runningProcess,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
  readonly runningProcess: AntigravityRunningProcess;
}) =>
  runningProcess.terminate.pipe(
    Effect.flatMap(() => transcriptHasContent({ fileSystem, transcriptPath })),
    Effect.map(cancellationOutcomeFromTranscriptContent),
    Effect.orElseSucceed(terminatedCancellationOutcome),
  );

/** Builds the common successful Antigravity driver turn result. */
const antigravityTurnResult = ({
  conversationId,
  runtimeEvents,
  cancel,
}: {
  readonly conversationId: string;
  readonly runtimeEvents: AgentRuntimeEventStream;
  readonly cancel: AgentDriverCancel;
}): AgentDriverTurnResult => ({
  runtimeEvents,
  externalSession: durableAntigravitySession({ conversationId }),
  cancel,
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
  const runningProcess = yield* startAntigravityTurnProcess({
    fileSystem,
    pathService,
    settings,
    spawner,
    turn,
    prompt,
    options,
    logFilePath,
  });
  const transcriptPath = transcriptPathForConversation({
    pathService,
    settings,
    conversationId: runningProcess.conversationId,
  });
  const runtimeEvents = runtimeEventsFromRunningProcess({
    fileSystem,
    pathService,
    settings,
    conversationId: runningProcess.conversationId,
    options,
    runningProcess,
    telemetryContext: transcriptTelemetryContextFromTurn(turn),
  });
  return {
    conversationId: runningProcess.conversationId,
    runtimeEvents,
    cancel: cancelRunningAntigravityTurn({
      fileSystem,
      transcriptPath,
      runningProcess,
    }),
  };
});

/** Starts a resumed Antigravity conversation and maps only newly appended transcript records. */
const startResumedAntigravityTurn = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
  spawner,
  turn,
  prompt,
  options,
  logFilePath,
  conversationId,
  observation,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly turn: AgentDriverTurn;
  readonly prompt: string;
  readonly options: AntigravityCliOptions;
  readonly logFilePath: string;
  readonly conversationId: string;
  readonly observation: AntigravityTranscriptObservation;
}) {
  const runningProcess = yield* startAntigravityTurnProcess({
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
  const exitFiber = yield* forkAntigravityProcessExit(runningProcess);
  yield* failOnImmediateResumeExit(exitFiber);
  const transcriptPath = transcriptPathForConversation({
    pathService,
    settings,
    conversationId: runningProcess.conversationId,
  });
  return antigravityTurnResult({
    conversationId: runningProcess.conversationId,
    runtimeEvents: runtimeEventsFromProcessExitFiber({
      fileSystem,
      pathService,
      settings,
      conversationId: runningProcess.conversationId,
      observation,
      options,
      exitFiber,
      telemetryContext: transcriptTelemetryContextFromTurn(turn),
    }),
    cancel: cancelRunningAntigravityTurn({
      fileSystem,
      transcriptPath,
      runningProcess,
    }),
  });
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
  const conversationId = yield* runAntigravityTurnProcess({
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
    externalSession: durableAntigravitySession({ conversationId }),
    bindingCwd: turn.cwd,
    lostSessionRecovery: {
      reason,
      diagnostics,
    },
    cancel: Effect.succeed(interruptedCancellationOutcome()),
  } satisfies AgentDriverTurnResult;
});

/** Recovers a preserved no-mutation resume binding that has no transcript yet. */
const recoverMissingResumeTranscript = (error: AgentDriverError) =>
  Match.value(error.message).pipe(
    Match.when("Antigravity transcript_full.jsonl was not created.", () =>
      Effect.succeed({
        records: [],
        state: emptyAntigravityTranscriptObservationState,
      } satisfies AntigravityTranscriptObservation),
    ),
    Match.orElse(() => Effect.fail(error)),
  );

/** Reads the transcript state that existed before a resumed Antigravity process is spawned. */
const observePriorResumeTranscript = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  settings,
  conversationId,
  telemetryContext,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly conversationId: string;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
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
    telemetryContext,
  }).pipe(Effect.catchTag("AgentDriverError", recoverMissingResumeTranscript));
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
      ({ cancel, conversationId, runtimeEvents }) =>
        antigravityTurnResult({ cancel, conversationId, runtimeEvents }),
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
                telemetryContext: transcriptTelemetryContextFromTurn(turn),
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
                    startResumedAntigravityTurn({
                      fileSystem,
                      pathService,
                      settings,
                      spawner,
                      turn,
                      prompt,
                      options,
                      logFilePath,
                      conversationId: cursor.conversationId,
                      observation,
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
                      onSuccess: Effect.succeed,
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
