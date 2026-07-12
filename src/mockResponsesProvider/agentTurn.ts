import { Effect, Exit, Match, Option, Ref, Schema, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import {
  type AgentDriverError,
  AgentDriverRegistry,
  type AgentDriverTurnResult,
  type AgentCancellationOutcome,
  type AgentRuntimeEventStream,
  type AgentTurnInput,
} from "./agentDriver.ts";
import type { AgentTurnContext } from "./agentTurnContext.ts";
import type { AgentTarget } from "./codexTurnContext.ts";
import { RelayLogger } from "./relayLogger.ts";
import {
  completeSessionBinding,
  deleteSessionBinding,
  type DurableExternalSession,
  EphemeralExternalSession,
  prepareSessionBinding,
  SessionDirectory,
  type SessionDirectoryError,
} from "./sessionDirectory.ts";
import { createLostSessionRecoveryRuntimeEvents } from "./sessionRecoveryPolicy.ts";
import { TurnConcurrency } from "./turnConcurrency.ts";

/** Normalized transport-neutral request accepted by the Agent Turn lifecycle. */
export interface AgentTurnRequest extends AgentTurnContext {
  readonly target: AgentTarget;
  readonly prompt: AgentTurnInput;
}

/** Running Agent turn exposed to transport adapters as events plus lifecycle finalization. */
export interface AgentTurnExecution {
  readonly runtimeEvents: AgentRuntimeEventStream;
  readonly cancel: EffectContract<
    AgentCancellationOutcome,
    AgentTurnCancellationConflict | SessionDirectoryError
  >;
}

/** Failure raised when cancellation targets a turn whose terminal finalization already won. */
export class AgentTurnCancellationConflict extends Schema.TaggedErrorClass<AgentTurnCancellationConflict>()(
  "AgentTurnCancellationConflict",
  { message: Schema.String },
) {}

/** Atomic lifecycle state coordinating stream finalization with explicit cancellation. */
type AgentTurnFinalizationState = "Open" | "Cancelling" | "Terminal";

/** Builds a terminal failed result when driver startup fails after turn acceptance. */
const failedDriverStartTurnResult = ({
  error,
}: {
  readonly error: AgentDriverError;
}): AgentDriverTurnResult => ({
  runtimeEvents: Stream.fromIterable([{ _tag: "TurnFailed", error }]),
  externalSession: new EphemeralExternalSession({}),
  cancel: Effect.succeed({ _tag: "Terminated", sessionReusable: false }),
});

/** Selects interrupted stream exits caused by a disconnected transport consumer. */
const interruptedExitOption = (
  exit: Exit.Exit<unknown, unknown>,
): Option.Option<Exit.Exit<unknown, unknown>> =>
  Option.fromUndefinedOr([exit].filter(Exit.hasInterrupts).at(0));

/** Starts or resumes one Agent turn and owns its complete runtime lifecycle. */
export const runAgentTurn = Effect.fnUntraced(function* (request: AgentTurnRequest) {
  const relayLogger = yield* RelayLogger;
  const driverRegistry = yield* AgentDriverRegistry;
  const sessionDirectory = yield* SessionDirectory;
  const turnConcurrency = yield* TurnConcurrency;
  const preparedSession = yield* prepareSessionBinding({
    context: request,
    target: request.target,
  });
  const driver = yield* driverRegistry.resolve(request.target);
  const lease = yield* turnConcurrency.acquire({
    key: {
      externalAgentKind: request.target.externalAgentKind,
      codexThreadId: request.identity.sessionId,
    },
    turnId: request.identity.turnId,
  });
  yield* relayLogger.log({
    _tag: "TurnInFlightAcquired",
    externalAgentKind: request.target.externalAgentKind,
    codexThreadId: request.identity.sessionId,
    turnId: request.identity.turnId,
  });

  const previousTarget = Option.fromUndefinedOr(preparedSession.previousTarget).pipe(
    Option.map((target) => ({
      requestedModel: target.requestedModel,
      externalAgentKind: target.externalAgentKind,
      externalModelSpecifier: target.externalModelSpecifier,
      rawDriverOptions: target.rawDriverOptions,
    })),
    Option.getOrUndefined,
  );
  const externalSessionId = Option.fromUndefinedOr(preparedSession.binding?.externalSession).pipe(
    Option.filter(
      (externalSession): externalSession is DurableExternalSession =>
        externalSession._tag === "Durable",
    ),
    Option.map((externalSession) => externalSession.driverResumeCursor),
    Option.getOrUndefined,
  );
  yield* relayLogger.log({
    _tag: "DriverStarted",
    threadId: request.identity.sessionId,
    turnId: request.identity.turnId,
    externalAgentKind: request.target.externalAgentKind,
    externalSessionId,
    previousTarget,
  });
  const driverTurnResult = yield* driver
    .startOrResumeTurn({
      context: request,
      target: request.target,
      prompt: request.prompt,
      cwd: preparedSession.cwd,
      requestedCwd: preparedSession.requestedCwd,
      previousTarget: preparedSession.previousTarget,
      externalSession: preparedSession.binding?.externalSession,
    })
    .pipe(
      Effect.catchTag("AgentDriverError", (error) =>
        Effect.succeed(failedDriverStartTurnResult({ error })),
      ),
    );
  yield* Option.match(Option.fromUndefinedOr(driverTurnResult.lostSessionRecovery), {
    onNone: () => Effect.void,
    onSome: (recovery) =>
      relayLogger.log({
        _tag: "LostSessionRecovered",
        threadId: request.identity.sessionId,
        turnId: request.identity.turnId,
        reason: recovery.reason,
        diagnostics: recovery.diagnostics,
      }),
  });
  const runtimeTurnFailed = yield* Ref.make(false);
  const runtimeTurnSucceeded = yield* Ref.make(false);
  const finalizationState = yield* Ref.make<AgentTurnFinalizationState>("Open");
  const driverRuntimeEvents = Option.match(
    Option.fromUndefinedOr(driverTurnResult.lostSessionRecovery),
    {
      onNone: () => driverTurnResult.runtimeEvents,
      onSome: () => Stream.fromIterable(createLostSessionRecoveryRuntimeEvents()),
    },
  );
  const runtimeEvents = driverRuntimeEvents.pipe(
    Stream.tap((runtimeEvent) =>
      Effect.gen(function* () {
        yield* relayLogger.log({
          _tag: "RuntimeEventRelayed",
          threadId: request.identity.sessionId,
          turnId: request.identity.turnId,
          runtimeEventTag: runtimeEvent._tag,
        });
        yield* Match.valueTags(runtimeEvent, {
          TurnSucceeded: () => Ref.set(runtimeTurnSucceeded, true),
          TurnFailed: (event) =>
            Effect.all(
              [
                Ref.set(runtimeTurnFailed, true),
                relayLogger.log({
                  _tag: "TurnFailed",
                  threadId: request.identity.sessionId,
                  turnId: request.identity.turnId,
                  message: event.error.message,
                }),
              ],
              { discard: true },
            ),
          ItemCreated: () => Effect.void,
          ContentStarted: () => Effect.void,
          ContentDelta: () => Effect.void,
          ContentCompleted: () => Effect.void,
          ItemCompleted: () => Effect.void,
          PermissionDenied: (event) =>
            relayLogger.log({
              _tag: "PermissionDenied",
              threadId: request.identity.sessionId,
              turnId: request.identity.turnId,
              toolName: event.toolName,
              toolUseId: event.toolUseId,
              message: event.message,
              decisionReason: event.decisionReason,
            }),
        });
      }),
    ),
  );
  const releaseFailedTurn = lease.release;
  const completeTurn = Effect.gen(function* () {
    yield* relayLogger.log({
      _tag: "TurnCompleted",
      threadId: request.identity.sessionId,
      turnId: request.identity.turnId,
    });
    yield* completeSessionBinding({
      context: request,
      target: request.target,
      prepared: preparedSession,
      externalSession: driverTurnResult.externalSession,
      bindingCwd: driverTurnResult.bindingCwd,
    }).pipe(Effect.provideService(SessionDirectory, sessionDirectory));
  }).pipe(Effect.ensuring(lease.release));
  const completeOrReleaseTurn = Effect.gen(function* () {
    const failed = yield* Ref.get(runtimeTurnFailed);
    const succeeded = yield* Ref.get(runtimeTurnSucceeded);
    return yield* Match.value({ failed, succeeded }).pipe(
      Match.when(
        ({ failed }) => failed,
        () => releaseFailedTurn,
      ),
      Match.when(
        ({ succeeded }) => succeeded,
        () => completeTurn,
      ),
      Match.orElse(() => releaseFailedTurn),
    );
  });
  const persistReusableCancellation = () =>
    completeSessionBinding({
      context: request,
      target: request.target,
      prepared: preparedSession,
      externalSession: driverTurnResult.externalSession,
      bindingCwd: driverTurnResult.bindingCwd,
    }).pipe(Effect.provideService(SessionDirectory, sessionDirectory), Effect.asVoid);
  const deleteNonReusableCancellation = () =>
    deleteSessionBinding({ context: request, target: request.target }).pipe(
      Effect.provideService(SessionDirectory, sessionDirectory),
    );
  const cancelTurn = Effect.gen(function* () {
    const cancellation = yield* driverTurnResult.cancel;
    yield* relayLogger.log({
      _tag: "TurnCancelled",
      externalAgentKind: request.target.externalAgentKind,
      codexThreadId: request.identity.sessionId,
      turnId: request.identity.turnId,
      outcomeTag: cancellation._tag,
      sessionReusable: cancellation.sessionReusable,
    });
    yield* Match.value(cancellation.sessionReusable).pipe(
      Match.when(true, persistReusableCancellation),
      Match.orElse(deleteNonReusableCancellation),
    );
    return cancellation;
  }).pipe(Effect.ensuring(Ref.set(finalizationState, "Terminal")), Effect.ensuring(lease.release));
  const cancelOnce = yield* Effect.cached(cancelTurn);
  const awaitCancellation = cancelOnce.pipe(Effect.asVoid);
  const claimFinalization = Ref.modify(finalizationState, (state) =>
    Match.value(state).pipe(
      Match.when("Open", () => ["Finalize", "Terminal"] as const),
      Match.when("Cancelling", () => ["AwaitCancellation", state] as const),
      Match.orElse(() => ["RejectCancellation", state] as const),
    ),
  );
  const finalizeWith = Effect.fnUntraced(function* (
    finalization: EffectContract<void, SessionDirectoryError>,
  ) {
    const decision = yield* claimFinalization;
    const finalizations = [finalization].filter(() => decision === "Finalize");
    const cancellations = [awaitCancellation].filter(() => decision === "AwaitCancellation");
    yield* Effect.all([...finalizations, ...cancellations], { discard: true });
  });
  const cancelExplicitly = Effect.gen(function* () {
    const decision = yield* Ref.modify(finalizationState, (state) =>
      Match.value(state).pipe(
        Match.when("Open", () => ["Finalize", "Cancelling"] as const),
        Match.when("Cancelling", () => ["AwaitCancellation", state] as const),
        Match.orElse(() => ["RejectCancellation", state] as const),
      ),
    );
    const cancellation = Match.value(decision).pipe(
      Match.when("Finalize", () => cancelOnce),
      Match.when("AwaitCancellation", () => cancelOnce),
      Match.orElse(() =>
        Effect.fail(
          new AgentTurnCancellationConflict({
            message: `Turn ${request.identity.turnId} is already terminal and cannot be cancelled.`,
          }),
        ),
      ),
    );
    return yield* cancellation;
  });
  const finalizeTurn = (exit: Exit.Exit<unknown, AgentDriverError>) =>
    Exit.match(exit, {
      onSuccess: () => finalizeWith(completeOrReleaseTurn),
      onFailure: () =>
        Option.match(interruptedExitOption(exit), {
          onNone: () => finalizeWith(releaseFailedTurn),
          onSome: () => cancelExplicitly.pipe(Effect.asVoid),
        }),
    }).pipe(Effect.ignore({ log: true, message: "Failed while finalizing Caara Agent turn." }));

  return {
    runtimeEvents: runtimeEvents.pipe(Stream.onExit(finalizeTurn)),
    cancel: cancelExplicitly,
  } satisfies AgentTurnExecution;
});
