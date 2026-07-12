import { Clock, Effect, Match, Option, Ref, Schema, Struct } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import type { AgentCancellationOutcome } from "./mockResponsesProvider/agentDriver.ts";
import type { AgentTurnExecution } from "./mockResponsesProvider/agentTurn.ts";
import type { PortableTurnId } from "./portableAgentIdentity.ts";
import { PortableAgentStore, PortableAgentStoreError } from "./portableAgentStore.ts";
import type {
  PortableTurnProjectionState,
  PortableTurnRecord,
} from "./portableAgentTurnInternal.ts";

/** Explicit failure when a portable cancellation targets no retained turn. */
export class PortableTurnNotFound extends Schema.TaggedErrorClass<PortableTurnNotFound>()(
  "PortableTurnNotFound",
  { message: Schema.String },
) {}

/** Explicit failure when cancellation loses the immutable terminal-state race. */
export class PortableTurnCancellationConflict extends Schema.TaggedErrorClass<PortableTurnCancellationConflict>()(
  "PortableTurnCancellationConflict",
  { message: Schema.String },
) {}

/** Explicit failure when durable working state has no live driver cancellation handle. */
export class PortableTurnCancellationUnavailable extends Schema.TaggedErrorClass<PortableTurnCancellationUnavailable>()(
  "PortableTurnCancellationUnavailable",
  { message: Schema.String },
) {}

/** Error channel exposed by portable cancellation orchestration. */
export type PortableTurnCancellationError =
  | PortableTurnNotFound
  | PortableTurnCancellationConflict
  | PortableTurnCancellationUnavailable
  | PortableAgentStoreError
  | (AgentTurnExecution["cancel"] extends EffectContract<unknown, infer E> ? E : never);

/** Classifies a retained durable turn that no longer has a live driver handle. */
const unavailableDurableTurn = ({
  state,
  turnId,
}: {
  readonly state: "Accepted" | "Working" | "Cancelling" | "Completed" | "Failed" | "Cancelled";
  readonly turnId: PortableTurnId;
}): EffectContract<never, PortableTurnCancellationConflict | PortableTurnCancellationUnavailable> =>
  Match.value(state).pipe(
    Match.when("Working", () =>
      Effect.fail(
        new PortableTurnCancellationUnavailable({
          message: `Portable turn ${turnId} is working without a live cancellation handle.`,
        }),
      ),
    ),
    Match.when("Cancelling", () =>
      Effect.fail(
        new PortableTurnCancellationUnavailable({
          message: `Portable turn ${turnId} has unresolved cancellation state without a live handle.`,
        }),
      ),
    ),
    Match.orElse(() =>
      Effect.fail(
        new PortableTurnCancellationConflict({
          message: `Portable turn ${turnId} is already terminal.`,
        }),
      ),
    ),
  );

/** Rejects cancellation when no live record exists, preserving durable-state distinctions. */
const validateLiveRecord = Effect.fnUntraced(function* ({
  record,
  store,
  turnId,
}: {
  readonly record: Option.Option<PortableTurnRecord>;
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly turnId: PortableTurnId;
}) {
  return yield* Option.match(record, {
    onSome: () => Effect.void,
    onNone: () =>
      Option.match(Option.fromUndefinedOr(store), {
        onNone: () =>
          Effect.fail(
            new PortableTurnNotFound({ message: `Portable turn ${turnId} was not found.` }),
          ),
        onSome: (durable) =>
          durable.loadTurn(turnId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: (): EffectContract<
                  never,
                  | PortableTurnNotFound
                  | PortableTurnCancellationConflict
                  | PortableTurnCancellationUnavailable
                > =>
                  Effect.fail(
                    new PortableTurnNotFound({
                      message: `Portable turn ${turnId} was not found.`,
                    }),
                  ),
                onSome: (
                  turn,
                ): EffectContract<
                  never,
                  | PortableTurnNotFound
                  | PortableTurnCancellationConflict
                  | PortableTurnCancellationUnavailable
                > => unavailableDurableTurn({ state: turn.state._tag, turnId }),
              }),
            ),
          ),
      }),
  });
});

/** Reconstructs the driver-owned cancellation result retained in terminal state. */
const cancellationFromProjection = (state: PortableTurnProjectionState) =>
  Match.value(state.terminal).pipe(
    Match.when({ _tag: "Cancelled", outcome: "Interrupted" }, () =>
      Effect.succeed({ _tag: "Interrupted", sessionReusable: true } as const),
    ),
    Match.when({ _tag: "Cancelled", outcome: "Abandoned" }, ({ sessionReusable }) =>
      Effect.succeed({ _tag: "Abandoned", sessionReusable } as const),
    ),
    Match.when({ _tag: "Cancelled", outcome: "Terminated" }, () =>
      Effect.succeed({ _tag: "Terminated", sessionReusable: false } as const),
    ),
    Match.orElse(() =>
      Effect.fail(
        new PortableTurnCancellationConflict({
          message: "Portable turn has no cancellation to reconcile.",
        }),
      ),
    ),
  );

/** Chooses whether a retained cancellation still needs durable reconciliation. */
const committedCancellationDecision = (committed: boolean): "reject" | "reconcile" =>
  Match.value(committed).pipe(
    Match.when(true, () => "reject" as const),
    Match.orElse(() => "reconcile" as const),
  );

/** Persists the cancellation terminal record before its human observation. */
const persistCancellation = Effect.fnUntraced(function* ({
  cancellation,
  current,
  record,
  store,
  turnId,
}: {
  readonly cancellation: AgentCancellationOutcome;
  readonly current: PortableTurnProjectionState;
  readonly record: PortableTurnRecord;
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly turnId: PortableTurnId;
}) {
  const updatedAtMillis = yield* Clock.currentTimeMillis;
  yield* Option.match(Option.fromUndefinedOr(store), {
    onNone: () => Effect.void,
    onSome: (durable) =>
      Effect.gen(function* () {
        const beforeTurn = yield* Ref.get(record.state);
        yield* Effect.all(
          [
            durable.saveTurn({
              schemaVersion: 1,
              turnId,
              sessionId: record.sessionId,
              state: {
                _tag: "Cancelled",
                outcome: cancellation._tag,
                sessionReusable: cancellation.sessionReusable,
              },
              createdAtMillis: record.createdAtMillis,
              updatedAtMillis,
              expiresAtMillis: record.expiresAtMillis,
            }),
          ].filter(() => !beforeTurn.durableCancellationCommitted),
          { discard: true },
        );
        yield* Ref.update(
          record.state,
          Struct.evolve({
            durableCancellationCommitted: () => true,
          }),
        );
        const beforeObservation = yield* Ref.get(record.state);
        yield* Effect.all(
          [
            durable.saveObservation({
              schemaVersion: 1,
              capability: record.capability,
              turnId,
              status: "cancelled",
              activity: current.observation.activity,
              finalAnswer: current.observation.finalAnswer,
              cancellation: current.observation.cancellation,
              createdAtMillis: record.createdAtMillis,
              updatedAtMillis,
              expiresAtMillis: record.expiresAtMillis,
            }),
          ].filter(() => !beforeObservation.observationCancellationCommitted),
          { discard: true },
        );
        yield* Ref.update(
          record.state,
          Struct.evolve({
            observationCancellationCommitted: () => true,
          }),
        );
      }),
  });
});

/** Reconciles a failed driver cancellation into matching durable terminal projections. */
const persistCancellationFailure = Effect.fnUntraced(function* ({
  current,
  record,
  store,
  turnId,
}: {
  readonly current: PortableTurnProjectionState;
  readonly record: PortableTurnRecord;
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly turnId: PortableTurnId;
}) {
  const updatedAtMillis = yield* Clock.currentTimeMillis;
  yield* Option.match(Option.fromUndefinedOr(store), {
    onNone: () => Effect.void,
    onSome: (durable) =>
      Effect.gen(function* () {
        const beforeTurn = yield* Ref.get(record.state);
        const turnWrites = [
          durable.saveTurn({
            schemaVersion: 1,
            turnId,
            sessionId: record.sessionId,
            state: { _tag: "Failed" },
            createdAtMillis: record.createdAtMillis,
            updatedAtMillis,
            expiresAtMillis: record.expiresAtMillis,
          }),
        ].filter(() => !beforeTurn.durableCancellationCommitted);
        yield* Effect.all(turnWrites, { discard: true });
        yield* Ref.update(
          record.state,
          Struct.evolve({
            durableCancellationCommitted: () => true,
          }),
        );
        const beforeObservation = yield* Ref.get(record.state);
        const observationWrites = [
          durable.saveObservation({
            schemaVersion: 1,
            capability: record.capability,
            turnId,
            status: "failed",
            activity: current.observation.activity,
            finalAnswer: current.observation.finalAnswer,
            createdAtMillis: record.createdAtMillis,
            updatedAtMillis,
            expiresAtMillis: record.expiresAtMillis,
          }),
        ].filter(() => !beforeObservation.observationCancellationCommitted);
        yield* Effect.all(observationWrites, { discard: true });
        yield* Ref.update(
          record.state,
          Struct.evolve({
            observationCancellationCommitted: () => true,
          }),
        );
      }),
  });
});

/** Executes one live cancellation or reconciles a partially persisted terminal result. */
export const cancelPortableTurn = Effect.fnUntraced(function* ({
  records,
  store,
  turnId,
}: {
  readonly records: ReadonlyMap<PortableTurnId, PortableTurnRecord>;
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly turnId: PortableTurnId;
}) {
  const recordOption = Option.fromUndefinedOr(records.get(turnId));
  yield* validateLiveRecord({ record: recordOption, store, turnId });
  const record = Option.getOrThrow(recordOption);
  const decision = yield* Ref.modify(record.state, (state) =>
    Match.value(state).pipe(
      Match.when(
        { finalization: "open" },
        () => ["start", { ...state, finalization: "cancelling" }] as const,
      ),
      Match.when(
        { finalization: "terminal", terminal: { _tag: "Cancelled" } },
        () =>
          [
            committedCancellationDecision(
              state.durableCancellationCommitted && state.observationCancellationCommitted,
            ),
            state,
          ] as const,
      ),
      Match.when(
        { finalization: "cancelling", terminal: { _tag: "Failed" } },
        () => ["reconcileFailure", state] as const,
      ),
      Match.orElse(() => ["reject", state] as const),
    ),
  );
  const rejection = Effect.fail(
    new PortableTurnCancellationConflict({
      message: `Portable turn ${turnId} is already terminal or cancelling.`,
    }),
  );
  const failedReconciliation = Ref.get(record.state).pipe(
    Effect.flatMap((current) => persistCancellationFailure({ current, record, store, turnId })),
    Effect.andThen(
      Ref.update(record.state, Struct.evolve({ finalization: () => "terminal" as const })),
    ),
  );
  const previousFailure = new PortableTurnCancellationConflict({
    message: `Portable turn ${turnId} cancellation previously failed.`,
  });
  const failPrevious = Effect.fail(previousFailure);
  const decisionEffects = [rejection].filter(() => decision === "reject");
  const failureReconciliations = [failedReconciliation.pipe(Effect.andThen(failPrevious))].filter(
    () => decision === "reconcileFailure",
  );
  yield* Effect.all([...decisionEffects, ...failureReconciliations], { discard: true });
  const startCancellation = Effect.gen(function* () {
    const persistIntent: EffectContract<void, PortableAgentStoreError> = Option.match(
      Option.fromUndefinedOr(store),
      {
        onNone: () => Effect.void,
        onSome: (durable) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((updatedAtMillis) =>
              durable.saveTurn({
                schemaVersion: 1,
                turnId,
                sessionId: record.sessionId,
                state: { _tag: "Cancelling" },
                createdAtMillis: record.createdAtMillis,
                updatedAtMillis,
                expiresAtMillis: record.expiresAtMillis,
              }),
            ),
          ),
      },
    );
    yield* persistIntent.pipe(
      Effect.tapError(() =>
        Ref.update(
          record.state,
          (state): PortableTurnProjectionState => ({ ...state, finalization: "open" }),
        ),
      ),
    );
    const persistDriverCancellationFailure = Ref.updateAndGet(
      record.state,
      (state): PortableTurnProjectionState => ({
        ...state,
        terminal: { _tag: "Failed" },
        observation: { ...state.observation, status: "failed" },
        finalization: "cancelling",
      }),
    ).pipe(
      Effect.flatMap((current) => persistCancellationFailure({ current, record, store, turnId })),
      Effect.andThen(
        Ref.update(record.state, Struct.evolve({ finalization: () => "terminal" as const })),
      ),
    );
    const cancellation = yield* record.cancel.pipe(
      Effect.tapError(() => persistDriverCancellationFailure),
    );
    yield* Ref.update(
      record.state,
      (state): PortableTurnProjectionState => ({
        ...state,
        terminal: {
          _tag: "Cancelled",
          outcome: cancellation._tag,
          sessionReusable: cancellation.sessionReusable,
        },
        observation: {
          ...state.observation,
          status: "cancelled",
          cancellation: {
            outcome: cancellation._tag,
            sessionReusable: cancellation.sessionReusable,
          },
        },
        finalization: "terminal",
        durableCancellationCommitted: store === undefined,
        observationCancellationCommitted: store === undefined,
      }),
    );
    return cancellation;
  });
  const reconciledCancellation = Ref.get(record.state).pipe(
    Effect.flatMap(cancellationFromProjection),
  );
  const cancellationEffect = Match.value(decision).pipe(
    Match.when("start", () => startCancellation),
    Match.orElse(() => reconciledCancellation),
  );
  const cancellation = yield* cancellationEffect;
  const current = yield* Ref.get(record.state);
  yield* persistCancellation({ cancellation, current, record, store, turnId });
  return cancellation;
});
