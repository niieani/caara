import { Effect, Exit, Fiber, Match, Option, Result, Stream } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import {
  AgentDriverError,
  type AgentRuntimeEventStream,
} from "../mockResponsesProvider/agentDriver.ts";
import type { AntigravityRunningProcess } from "./cliProcess.ts";
import type { AntigravityCliOptions } from "./options.ts";
import type { AntigravityCliSettingsValue } from "./settings.ts";
import {
  antigravityTranscriptFullPath,
  emptyAntigravityTranscriptObservationState,
  observeAntigravityTranscriptContent,
  type AntigravityTranscriptObservation,
  type AntigravityTranscriptObservationState,
  type AntigravityTranscriptRecord,
  type AntigravityTranscriptTelemetryContext,
} from "./transcript.ts";
import {
  initialAntigravityRuntimeEventState,
  orderAntigravityTranscriptRecordsByStepIndex,
  runtimeEventsFromAntigravityTranscriptRecords,
  terminalRuntimeEventsFromAntigravityTranscript,
  type AntigravityRuntimeEventState,
} from "./transcriptRuntimeEvents.ts";

/** Streaming state for one live Antigravity transcript observation loop. */
interface AntigravityRuntimeStreamState {
  readonly observationState: AntigravityTranscriptObservationState;
  readonly runtimeState: AntigravityRuntimeEventState;
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly mappedStepIndexes: readonly number[];
  readonly done: boolean;
}

/** Fiber that reports Antigravity process completion as data instead of failing detached. */
export type AntigravityProcessExitFiber = Fiber.Fiber<Result.Result<void, AgentDriverError>, never>;

/** Options needed to read one transcript snapshot during live process observation. */
interface ReadTranscriptSnapshotOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: string;
  readonly state: AntigravityTranscriptObservationState;
  readonly requireTranscript: boolean;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}

/** Options for one live Antigravity runtime stream pull. */
interface RuntimeEventsChunkOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly exitFiber: AntigravityProcessExitFiber;
  readonly transcriptPath: string;
  readonly state: AntigravityRuntimeStreamState;
  readonly options: AntigravityCliOptions;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}

/** Options for building a live runtime stream from a running Antigravity process. */
interface RunningProcessRuntimeEventsOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly conversationId: string;
  readonly observation?: AntigravityTranscriptObservation;
  readonly options: AntigravityCliOptions;
  readonly runningProcess: AntigravityRunningProcess;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}

/** Options for building a live runtime stream from an already-forked exit observer. */
interface ProcessExitFiberRuntimeEventsOptions extends Omit<
  RunningProcessRuntimeEventsOptions,
  "runningProcess"
> {
  readonly exitFiber: AntigravityProcessExitFiber;
}

/** Real-time grace window for a resumed CLI process to reject a stale conversation id. */
const immediateResumeExitProbeMillis = 200;

/** Builds the transcript path for one Antigravity conversation id. */
export const transcriptPathForConversation = ({
  pathService,
  settings,
  conversationId,
}: {
  readonly pathService: Path.Path;
  readonly settings: AntigravityCliSettingsValue;
  readonly conversationId: string;
}): string =>
  antigravityTranscriptFullPath({
    pathService,
    homeDir: settings.homeDir,
    conversationId,
  });

/** Initial state for streaming current-turn transcript records. */
const initialRuntimeStreamState = ({
  observationState = emptyAntigravityTranscriptObservationState,
}: {
  readonly observationState?: AntigravityTranscriptObservationState;
}): AntigravityRuntimeStreamState => ({
  observationState,
  runtimeState: initialAntigravityRuntimeEventState(),
  records: [],
  mappedStepIndexes: observationState.observedStepIndexes,
  done: false,
});

/** Returns the next contiguous Antigravity step index expected by the live mapper. */
const nextMappedStepIndex = (mappedStepIndexes: readonly number[]): number =>
  (mappedStepIndexes.toSorted((left, right) => right - left).at(0) ?? -1) + 1;

/** Accumulator for selecting the contiguous unmapped transcript prefix ready for live mapping. */
interface ReadyRuntimeRecordsAccumulator {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly expectedStepIndex: number;
  readonly closed: boolean;
}

/** Appends one record to the ready prefix while step indexes remain contiguous. */
const appendReadyRuntimeRecord = (
  accumulator: ReadyRuntimeRecordsAccumulator,
  record: AntigravityTranscriptRecord,
): ReadyRuntimeRecordsAccumulator =>
  Match.value(accumulator.closed || record.step_index !== accumulator.expectedStepIndex).pipe(
    Match.when(true, () => ({
      ...accumulator,
      closed: true,
    })),
    Match.orElse(() => ({
      records: [...accumulator.records, record],
      expectedStepIndex: accumulator.expectedStepIndex + 1,
      closed: false,
    })),
  );

/** Returns the unmapped contiguous transcript prefix that is ready before process exit. */
const contiguousReadyRuntimeRecords = ({
  unmapped,
  mappedStepIndexes,
}: {
  readonly unmapped: readonly AntigravityTranscriptRecord[];
  readonly mappedStepIndexes: readonly number[];
}): readonly AntigravityTranscriptRecord[] =>
  unmapped.reduce(appendReadyRuntimeRecord, {
    records: [],
    expectedStepIndex: nextMappedStepIndex(mappedStepIndexes),
    closed: false,
  }).records;

/** Returns records that can be safely mapped without violating semantic step order. */
const readyRuntimeRecords = ({
  records,
  mappedStepIndexes,
  allowGaps,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly mappedStepIndexes: readonly number[];
  readonly allowGaps: boolean;
}): readonly AntigravityTranscriptRecord[] => {
  const mappedStepIndexSet = new Set(mappedStepIndexes);
  const unmapped = orderAntigravityTranscriptRecordsByStepIndex(records).filter(
    (record) => !mappedStepIndexSet.has(record.step_index),
  );
  return Match.value(allowGaps).pipe(
    Match.when(true, () => unmapped),
    Match.orElse(() => contiguousReadyRuntimeRecords({ unmapped, mappedStepIndexes })),
  );
};

/** Returns an empty transcript observation while a still-running process has not created a file. */
const emptyTranscriptObservation = (
  state: AntigravityTranscriptObservationState,
): AntigravityTranscriptObservation => ({
  records: [],
  state,
});

/** Converts an observed child-process result into the driver error channel. */
const processResultAsEffect = (result: Result.Result<void, AgentDriverError>) =>
  Result.match(result, {
    onFailure: Effect.fail,
    onSuccess: () => Effect.void,
  });

/** Reads one transcript snapshot, tolerating absence only while the process is still running. */
const readTranscriptSnapshot = Effect.fnUntraced(function* ({
  fileSystem,
  transcriptPath,
  state,
  requireTranscript,
  telemetryContext,
}: ReadTranscriptSnapshotOptions) {
  const content = yield* fileSystem.readFileString(transcriptPath).pipe(Effect.option);
  return yield* Option.match(content, {
    onNone: () =>
      Match.value(requireTranscript).pipe(
        Match.when(true, () =>
          Effect.fail(
            new AgentDriverError({
              message: "Antigravity transcript_full.jsonl was not created.",
            }),
          ),
        ),
        Match.orElse(() => Effect.succeed(emptyTranscriptObservation(state))),
      ),
    onSome: (text) =>
      observeAntigravityTranscriptContent({ state, content: text, telemetryContext }),
  });
});

/** Host-timer transcript polling wait not controlled by Effect test clocks. */
const waitForNextTranscriptPoll = Effect.promise<void>(
  () => new Promise((resolve) => globalThis.setTimeout(resolve, 20)),
);

/** Returns the currently observed process result, if the await fiber has completed. */
const processExitOption = (exitFiber: AntigravityProcessExitFiber) =>
  Option.fromUndefinedOr(exitFiber.pollUnsafe()).pipe(
    Option.map((outerExit) =>
      Exit.match(outerExit, {
        onFailure: () =>
          Result.fail(
            new AgentDriverError({
              message: "Antigravity CLI process observer was interrupted.",
            }),
          ),
        onSuccess: (processExit) => processExit,
      }),
    ),
  );

/** Fails quickly when a just-started resumed process immediately rejects the cursor. */
export const failOnImmediateResumeExit = (exitFiber: AntigravityProcessExitFiber) =>
  Effect.promise<void>(
    () => new Promise((resolve) => globalThis.setTimeout(resolve, immediateResumeExitProbeMillis)),
  ).pipe(
    Effect.flatMap(() =>
      Option.match(processExitOption(exitFiber), {
        onNone: () => Effect.void,
        onSome: processResultAsEffect,
      }),
    ),
  );

/** Produces the next runtime event chunk when the live transcript stream is still open. */
const nextOpenRuntimeEventsChunk = Effect.fnUntraced(function* ({
  fileSystem,
  exitFiber,
  transcriptPath,
  state,
  options,
  telemetryContext,
}: RuntimeEventsChunkOptions) {
  const exitOption = processExitOption(exitFiber);
  const processExited = Option.isSome(exitOption);
  yield* Option.match(exitOption, {
    onNone: () => Effect.void,
    onSome: processResultAsEffect,
  });

  const observation = yield* readTranscriptSnapshot({
    fileSystem,
    transcriptPath,
    state: state.observationState,
    requireTranscript: processExited,
    telemetryContext,
  });
  const records = [...state.records, ...observation.records];
  const recordsReadyForMapping = readyRuntimeRecords({
    records,
    mappedStepIndexes: state.mappedStepIndexes,
    allowGaps: processExited,
  });
  const [runtimeState, mappedEvents] = runtimeEventsFromAntigravityTranscriptRecords({
    records: recordsReadyForMapping,
    reasoning: options.reasoning,
    activity: options.activity,
    state: state.runtimeState,
  });
  const nextState = {
    observationState: observation.state,
    runtimeState,
    records,
    mappedStepIndexes: [
      ...state.mappedStepIndexes,
      ...recordsReadyForMapping.map((record) => record.step_index),
    ],
    done: processExited,
  } satisfies AntigravityRuntimeStreamState;
  const terminalCondition = Effect.succeed(processExited);
  const terminalEvents = yield* terminalRuntimeEventsFromAntigravityTranscript({
    records,
    telemetryContext,
  }).pipe(Effect.when(terminalCondition), Effect.map(Option.getOrElse(() => [] as const)));
  const events = [...mappedEvents, ...terminalEvents];
  const shouldPoll = Effect.succeed(events.length === 0);
  yield* Effect.when(waitForNextTranscriptPoll, shouldPoll);
  return [events, nextState] as const;
});

/** Produces the next non-empty runtime event chunk from a live Antigravity transcript. */
function nextRuntimeEventsChunk(options: RuntimeEventsChunkOptions) {
  const closedChunk = Effect.map(Effect.void, () => undefined);
  return Match.value(options.state.done).pipe(
    Match.when(true, () => closedChunk),
    Match.orElse(() => nextOpenRuntimeEventsChunk(options)),
  );
}

/** Forks a child-process exit observer without tying short polling to scope finalization. */
export const forkAntigravityProcessExit = (runningProcess: AntigravityRunningProcess) =>
  runningProcess.awaitExit.pipe(Effect.result, Effect.forkDetach({ startImmediately: true }));

/** Builds a runtime stream over a shared live Antigravity process exit observer. */
export const runtimeEventsFromProcessExitFiber = ({
  fileSystem,
  pathService,
  settings,
  conversationId,
  observation,
  options,
  exitFiber,
  telemetryContext,
}: ProcessExitFiberRuntimeEventsOptions): AgentRuntimeEventStream => {
  const transcriptPath = transcriptPathForConversation({ pathService, settings, conversationId });
  const initialState = initialRuntimeStreamState({ observationState: observation?.state });
  const ignoreExitFiberInterrupt = Fiber.interrupt(exitFiber).pipe(Effect.ignore);
  return Stream.unfold(initialState, (state) =>
    nextRuntimeEventsChunk({
      fileSystem,
      exitFiber,
      transcriptPath,
      state,
      options,
      telemetryContext,
    }),
  ).pipe(Stream.flattenIterable, Stream.ensuring(ignoreExitFiberInterrupt));
};

/** Builds a runtime stream that observes Antigravity transcript records while the process runs. */
export const runtimeEventsFromRunningProcess = ({
  fileSystem,
  pathService,
  settings,
  conversationId,
  observation,
  options,
  runningProcess,
  telemetryContext,
}: RunningProcessRuntimeEventsOptions): AgentRuntimeEventStream =>
  Stream.unwrap(
    Effect.map(forkAntigravityProcessExit(runningProcess), (exitFiber) =>
      runtimeEventsFromProcessExitFiber({
        fileSystem,
        pathService,
        settings,
        conversationId,
        observation,
        options,
        exitFiber,
        telemetryContext,
      }),
    ),
  );
