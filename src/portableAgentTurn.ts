import { Clock, Context, Effect, Layer, Match, Option, Ref, Schema, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import type {
  AgentCancellationOutcome,
  AgentRuntimeEvent,
  AgentRuntimeEventStream,
} from "./mockResponsesProvider/agentDriver.ts";
import type { AgentTurnExecution } from "./mockResponsesProvider/agentTurn.ts";
import {
  cancelPortableTurn,
  type PortableTurnCancellationError,
} from "./portableAgentCancellation.ts";
import type {
  ObservationCapability as ObservationCapabilityType,
  PortableTurnId as PortableTurnIdType,
} from "./portableAgentIdentity.ts";
import {
  type DurablePortableTurn,
  PortableAgentStore,
  PortableAgentStoreError,
  portableAgentRetentionMillis,
} from "./portableAgentStore.ts";
import {
  type PortableTurnProjectionState as ProjectionState,
  type PortableTurnRecord,
} from "./portableAgentTurnInternal.ts";

/** Agent-facing coarse state while a portable turn remains active. */
export interface PortableTurnWorking {
  readonly _tag: "Working";
}

/** Agent-facing terminal state containing only the final answer. */
export interface PortableTurnCompleted {
  readonly _tag: "Completed";
  readonly finalAnswer: string;
}

/** Agent-facing terminal failure without private runtime activity. */
export interface PortableTurnFailed {
  readonly _tag: "Failed";
}

/** Agent-facing cancelled state containing only the driver outcome and session policy. */
export interface PortableTurnCancelled {
  readonly _tag: "Cancelled";
  readonly outcome: AgentCancellationOutcome["_tag"];
  readonly sessionReusable: boolean;
}

/** Agent-facing projection intentionally excluding runtime observations. */
export type PortableTurnTerminalProjection =
  | PortableTurnWorking
  | PortableTurnCompleted
  | PortableTurnFailed
  | PortableTurnCancelled;

/** Human-only observation projection containing live normalized activity. */
export interface PortableTurnObservation {
  readonly status: "working" | "completed" | "failed" | "cancelled";
  readonly activity: string;
  readonly finalAnswer: string | undefined;
  readonly cancellation?: {
    readonly outcome: AgentCancellationOutcome["_tag"];
    readonly sessionReusable: boolean;
  };
}

/** Service exposing agent-safe terminal reads and capability-protected human observations. */
export class PortableAgentTurns extends Context.Service<
  PortableAgentTurns,
  {
    readonly register: (input: {
      readonly turnId: PortableTurnIdType;
      readonly sessionId: string;
      readonly capability: ObservationCapabilityType;
      readonly runtimeEvents: AgentRuntimeEventStream;
      readonly cancel: AgentTurnExecution["cancel"];
      readonly onRegistrationFailure: EffectContract<void>;
    }) => EffectContract<void, PortableAgentStoreError>;
    readonly wait: (
      turnId: PortableTurnIdType,
    ) => EffectContract<Option.Option<PortableTurnTerminalProjection>, PortableAgentStoreError>;
    readonly observe: (
      capability: ObservationCapabilityType,
    ) => EffectContract<Option.Option<PortableTurnObservation>, PortableAgentStoreError>;
    readonly cancel: (
      turnId: PortableTurnIdType,
    ) => EffectContract<AgentCancellationOutcome, PortableTurnCancellationError>;
  }
>()("@caara/PortableAgentTurns") {}

/** Initial projections for a newly accepted portable turn. */
const initialProjectionState = (): ProjectionState => ({
  itemPhases: new Map(),
  terminal: { _tag: "Working" },
  observation: { status: "working", activity: "", finalAnswer: undefined },
  finalization: "open",
  durableCancellationCommitted: false,
  observationCancellationCommitted: false,
});

/** Applies one runtime event while terminal finalization remains open. */
const projectOpenRuntimeEvent = (
  state: ProjectionState,
  event: AgentRuntimeEvent,
): ProjectionState =>
  Match.valueTags(event, {
    ItemCreated: (created): ProjectionState => {
      const phase = Match.value({ kind: created.itemKind, phase: created.messagePhase }).pipe(
        Match.when({ kind: "assistant_message", phase: undefined }, () => "final_answer" as const),
        Match.orElse(({ phase: selected }) => selected),
      );
      return {
        ...state,
        itemPhases: new Map(state.itemPhases).set(created.itemId, phase),
      };
    },
    ContentDelta: (delta): ProjectionState => {
      const finalAnswer = Match.value(state.itemPhases.get(delta.itemId)).pipe(
        Match.when("final_answer", () => `${state.observation.finalAnswer ?? ""}${delta.text}`),
        Match.orElse(() => state.observation.finalAnswer),
      );
      return {
        ...state,
        observation: {
          ...state.observation,
          activity: `${state.observation.activity}${delta.text}`,
          finalAnswer,
        },
      };
    },
    TurnSucceeded: (): ProjectionState => {
      const finalAnswer = state.observation.finalAnswer ?? "";
      return {
        ...state,
        terminal: { _tag: "Completed", finalAnswer },
        observation: { ...state.observation, status: "completed", finalAnswer },
        finalization: "terminal",
      };
    },
    TurnFailed: (): ProjectionState => ({
      ...state,
      terminal: { _tag: "Failed" },
      observation: { ...state.observation, status: "failed" },
      finalization: "terminal",
    }),
    ContentStarted: () => state,
    ContentCompleted: () => state,
    ItemCompleted: () => state,
    PermissionDenied: (denied): ProjectionState => ({
      ...state,
      observation: {
        ...state.observation,
        activity: `${state.observation.activity}\nPermission denied: ${denied.toolName}: ${denied.message}`,
      },
    }),
  });

/** Applies one runtime event without mutating a claimed or terminal projection. */
const projectRuntimeEvent = (state: ProjectionState, event: AgentRuntimeEvent): ProjectionState =>
  Match.value(state.finalization).pipe(
    Match.when("open", () => projectOpenRuntimeEvent(state, event)),
    Match.orElse(() => state),
  );

/** Persists both projections after one event without mixing capability data into turn state. */
const persistProjection = Effect.fnUntraced(function* ({
  store,
  record,
  turnId,
  current,
}: {
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly record: PortableTurnRecord;
  readonly turnId: PortableTurnIdType;
  readonly current: ProjectionState;
}) {
  return yield* Option.match(Option.fromUndefinedOr(store), {
    onNone: () => Effect.void,
    onSome: (durable) =>
      Effect.gen(function* () {
        const updatedAtMillis = yield* Clock.currentTimeMillis;
        const durableState = Match.valueTags(current.terminal, {
          Working: () =>
            Match.value(current.finalization).pipe(
              Match.when("cancelling", () => ({ _tag: "Cancelling" }) as const),
              Match.orElse(() => ({ _tag: "Working" }) as const),
            ),
          Completed: ({ finalAnswer }) => ({ _tag: "Completed", finalAnswer }) as const,
          Failed: () => ({ _tag: "Failed" }) as const,
          Cancelled: ({ outcome, sessionReusable }) =>
            ({ _tag: "Cancelled", outcome, sessionReusable }) as const,
        });
        yield* Effect.all(
          [
            durable.saveObservation({
              schemaVersion: 1,
              capability: record.capability,
              turnId,
              status: current.observation.status,
              activity: current.observation.activity,
              finalAnswer: current.observation.finalAnswer,
              createdAtMillis: record.createdAtMillis,
              updatedAtMillis,
              expiresAtMillis: record.expiresAtMillis,
            }),
            durable.saveTurn({
              schemaVersion: 1,
              turnId,
              sessionId: record.sessionId,
              state: durableState,
              createdAtMillis: record.createdAtMillis,
              updatedAtMillis,
              expiresAtMillis: record.expiresAtMillis,
            }),
          ],
          { concurrency: 1, discard: true },
        );
      }),
  });
});

/** Persists a runtime stream defect as a terminal failure in both durable projections. */
const persistStreamFailure = Effect.fnUntraced(function* ({
  store,
  record,
  turnId,
  current,
}: {
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly record: PortableTurnRecord;
  readonly turnId: PortableTurnIdType;
  readonly current: ProjectionState;
}) {
  return yield* Option.match(Option.fromUndefinedOr(store), {
    onNone: () => Effect.void,
    onSome: (durable) =>
      Effect.gen(function* () {
        const updatedAtMillis = yield* Clock.currentTimeMillis;
        yield* Effect.all(
          [
            durable.saveTurn({
              schemaVersion: 1,
              turnId,
              sessionId: record.sessionId,
              state: { _tag: "Failed" },
              createdAtMillis: record.createdAtMillis,
              updatedAtMillis,
              expiresAtMillis: record.expiresAtMillis,
            }),
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
          ],
          { discard: true },
        );
      }),
  });
});

/** Maps durable state into the strictly agent-safe terminal projection. */
const terminalProjectionFromDurableTurn = (
  turn: DurablePortableTurn,
): PortableTurnTerminalProjection =>
  Match.value(turn.state).pipe(
    Match.when(
      { _tag: "Completed" },
      ({ finalAnswer }) => ({ _tag: "Completed", finalAnswer }) as const,
    ),
    Match.when({ _tag: "Failed" }, () => ({ _tag: "Failed" }) as const),
    Match.when(
      { _tag: "Cancelled" },
      ({ outcome, sessionReusable }) => ({ _tag: "Cancelled", outcome, sessionReusable }) as const,
    ),
    Match.orElse(() => ({ _tag: "Working" }) as const),
  );

/** Maps durable cancellation into the viewer's cancellation display. */
const recoveredObservationStatus = (
  status: "working" | "completed" | "failed" | "cancelled",
): PortableTurnObservation["status"] =>
  Match.value(status).pipe(
    Match.when("cancelled", () => "cancelled" as const),
    Match.orElse((value) => value),
  );

/** Live process-local implementation; durability and retention are intentionally deferred. */
const makePortableAgentTurns = ({
  store,
  records,
  retentionMillis = portableAgentRetentionMillis,
}: {
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly records: Map<PortableTurnIdType, PortableTurnRecord>;
  readonly retentionMillis?: number;
}): typeof PortableAgentTurns.Service => {
  const cleanupDurableExpiry = Option.match(Option.fromUndefinedOr(store), {
    onNone: () => Effect.void,
    onSome: (durable) => durable.cleanupExpired,
  });
  const activeMemoryRecord = Effect.fnUntraced(function* ({
    turnId,
    record,
  }: {
    readonly turnId: PortableTurnIdType;
    readonly record: PortableTurnRecord;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const active = record.expiresAtMillis > now;
    const expiredTurnIds = [turnId].filter(() => !active);
    yield* Effect.forEach(
      expiredTurnIds,
      (expiredTurnId) =>
        Effect.sync(() => records.delete(expiredTurnId)).pipe(Effect.andThen(cleanupDurableExpiry)),
      { discard: true },
    );
    return Option.some(record).pipe(Option.filter(() => active));
  });
  const loadDurableTerminal = (turnId: PortableTurnIdType) =>
    Option.match(Option.fromUndefinedOr(store), {
      onNone: () => Effect.succeed(Option.none<PortableTurnTerminalProjection>()),
      onSome: (durable) =>
        durable.cleanupExpired.pipe(
          Effect.andThen(durable.loadTurn(turnId)),
          Effect.map(Option.map(terminalProjectionFromDurableTurn)),
        ),
    });
  const loadDurableObservation = (capability: ObservationCapabilityType) =>
    Option.match(Option.fromUndefinedOr(store), {
      onNone: () => Effect.succeed(Option.none<PortableTurnObservation>()),
      onSome: (durable) =>
        durable.cleanupExpired.pipe(
          Effect.andThen(durable.loadObservation(capability)),
          Effect.map(
            Option.map((value) => ({
              status: recoveredObservationStatus(value.status),
              activity: value.activity,
              finalAnswer: value.finalAnswer,
              ...Option.match(Option.fromUndefinedOr(value.cancellation), {
                onNone: () => ({}),
                onSome: (cancellation) => ({ cancellation }),
              }),
            })),
          ),
        ),
    });
  return {
    register: Effect.fnUntraced(function* ({
      turnId,
      sessionId,
      capability,
      runtimeEvents,
      cancel,
      onRegistrationFailure,
    }: {
      readonly turnId: PortableTurnIdType;
      readonly sessionId: string;
      readonly capability: ObservationCapabilityType;
      readonly runtimeEvents: AgentRuntimeEventStream;
      readonly cancel: AgentTurnExecution["cancel"];
      readonly onRegistrationFailure: EffectContract<void>;
    }) {
      const createdAtMillis = yield* Clock.currentTimeMillis;
      const expiresAtMillis = createdAtMillis + retentionMillis;
      const state = yield* Ref.make(initialProjectionState());
      const record = { capability, sessionId, createdAtMillis, expiresAtMillis, state, cancel };
      yield* Effect.sync(() => records.set(turnId, record));
      const initializeDurableState = Option.match(Option.fromUndefinedOr(store), {
        onNone: () => Effect.void,
        onSome: (durable) =>
          Effect.gen(function* () {
            yield* Effect.all(
              [
                durable.saveTurn({
                  schemaVersion: 1,
                  turnId,
                  sessionId,
                  state: { _tag: "Accepted" },
                  createdAtMillis,
                  updatedAtMillis: createdAtMillis,
                  expiresAtMillis,
                }),
                durable.saveObservation({
                  schemaVersion: 1,
                  capability,
                  turnId,
                  status: "working",
                  activity: "",
                  createdAtMillis,
                  updatedAtMillis: createdAtMillis,
                  expiresAtMillis,
                }),
              ],
              { discard: true },
            );
            yield* durable.saveTurn({
              schemaVersion: 1,
              turnId,
              sessionId,
              state: { _tag: "Working" },
              createdAtMillis,
              updatedAtMillis: createdAtMillis,
              expiresAtMillis,
            });
          }),
      });
      const rollbackRegistration: EffectContract<void> = Option.match(
        Option.fromUndefinedOr(store),
        {
          onNone: () => onRegistrationFailure,
          onSome: (durable) => {
            const cleanup = Effect.all(
              [durable.deleteTurn(turnId), durable.deleteObservation(capability)],
              {
                discard: true,
              },
            ).pipe(Effect.ignore);
            return cleanup.pipe(Effect.ensuring(onRegistrationFailure));
          },
        },
      );
      const failRegistration = Effect.fnUntraced(function* (error: PortableAgentStoreError) {
        yield* Effect.sync(() => records.delete(turnId));
        yield* rollbackRegistration;
        return yield* error;
      });
      yield* initializeDurableState.pipe(Effect.catch(failRegistration));
      const consumeRuntimeEvent = Effect.fnUntraced(function* (event: AgentRuntimeEvent) {
        const current = yield* Ref.updateAndGet(state, (projection) =>
          projectRuntimeEvent(projection, event),
        );
        yield* persistProjection({ store, record, turnId, current });
      });
      const persistRuntimeFailure = Effect.fnUntraced(function* (error: {
        readonly message: string;
      }) {
        const [shouldPersist, current] = yield* Ref.modify(
          state,
          (projection): readonly [readonly [boolean, ProjectionState], ProjectionState] =>
            Match.value(projection.finalization).pipe(
              Match.when("open", () => {
                const failed = {
                  ...projection,
                  terminal: { _tag: "Failed" },
                  observation: {
                    ...projection.observation,
                    status: "failed",
                    activity: `${projection.observation.activity}${error.message}`,
                  },
                  finalization: "terminal",
                } satisfies ProjectionState;
                return [[true, failed], failed] as const;
              }),
              Match.orElse(() => [[false, projection], projection] as const),
            ),
        );
        const persistEffects = [persistStreamFailure({ store, record, turnId, current })].filter(
          () => shouldPersist,
        );
        yield* Effect.all(persistEffects, { discard: true });
      });
      yield* runtimeEvents.pipe(
        Stream.runForEach(consumeRuntimeEvent),
        Effect.catch(persistRuntimeFailure),
        Effect.forkDetach({ startImmediately: true }),
      );
    }),
    wait: Effect.fnUntraced(function* (turnId) {
      const memory = yield* Option.match(Option.fromUndefinedOr(records.get(turnId)), {
        onNone: () => Effect.succeed(Option.none<PortableTurnRecord>()),
        onSome: (record) => activeMemoryRecord({ turnId, record }),
      });
      return yield* Option.match(memory, {
        onNone: () => loadDurableTerminal(turnId),
        onSome: (record) =>
          Ref.get(record.state).pipe(Effect.map((state) => Option.some(state.terminal))),
      });
    }),
    observe: Effect.fnUntraced(function* (capability) {
      const entry = [...records.entries()].find(
        ([, candidate]) => candidate.capability === capability,
      );
      const memory = yield* Option.match(Option.fromUndefinedOr(entry), {
        onNone: () => Effect.succeed(Option.none<PortableTurnRecord>()),
        onSome: ([turnId, record]) => activeMemoryRecord({ turnId, record }),
      });
      return yield* Option.match(memory, {
        onNone: () => loadDurableObservation(capability),
        onSome: (record) =>
          Ref.get(record.state).pipe(Effect.map((state) => Option.some(state.observation))),
      });
    }),
    cancel: (turnId) =>
      cancelPortableTurn({
        turnId,
        records,
        store,
      }),
  };
};

/** Process-local registry shared by the live HTTP start, wait, and viewer routes. */
export const portableAgentTurnsProcessLocal = makePortableAgentTurns({
  store: undefined,
  records: new Map(),
});

/** Live process-local implementation; durability and retention are intentionally deferred. */
export const portableAgentTurnsLive = Layer.succeed(
  PortableAgentTurns,
  portableAgentTurnsProcessLocal,
);

/** Durable implementation backed by the configured portable Agent store. */
export const portableAgentTurnsDurableLive = ({
  records,
}: {
  readonly records: Map<PortableTurnIdType, PortableTurnRecord>;
}) => {
  return Layer.effect(
    PortableAgentTurns,
    Effect.gen(function* () {
      const store = yield* PortableAgentStore;
      const configured = process.env.CAARA_PORTABLE_RETENTION_MILLIS;
      const retentionMillis = yield* Option.match(Option.fromUndefinedOr(configured), {
        onNone: () => Effect.succeed(portableAgentRetentionMillis),
        onSome: (value) =>
          Schema.decodeUnknownEffect(Schema.FiniteFromString)(value).pipe(
            Effect.filterOrFail((millis) => millis > 0),
            Effect.mapError(
              () =>
                new PortableAgentStoreError({
                  message: "CAARA_PORTABLE_RETENTION_MILLIS must be a positive number.",
                }),
            ),
          ),
      });
      return makePortableAgentTurns({ store, records, retentionMillis });
    }),
  );
};
