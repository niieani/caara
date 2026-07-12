import { Clock, Context, Effect, Layer, Match, Option, Ref, Schema, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import type {
  AgentRuntimeEvent,
  AgentRuntimeEventStream,
} from "./mockResponsesProvider/agentDriver.ts";
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

/** Agent-facing projection intentionally excluding runtime observations. */
export type PortableTurnTerminalProjection =
  | PortableTurnWorking
  | PortableTurnCompleted
  | PortableTurnFailed;

/** Human-only observation projection containing live normalized activity. */
export interface PortableTurnObservation {
  readonly status: "working" | "completed" | "failed";
  readonly activity: string;
  readonly finalAnswer: string | undefined;
}

/** Mutable projection state owned by the service's single runtime-stream consumer. */
interface ProjectionState {
  readonly itemPhases: ReadonlyMap<string, "commentary" | "final_answer" | undefined>;
  readonly terminal: PortableTurnTerminalProjection;
  readonly observation: PortableTurnObservation;
}

/** Registered in-memory portable turn projections for this tracer-bullet slice. */
interface PortableTurnRecord {
  readonly capability: ObservationCapabilityType;
  readonly sessionId: string;
  readonly createdAtMillis: number;
  readonly expiresAtMillis: number;
  readonly state: Ref.Ref<ProjectionState>;
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
      readonly onRegistrationFailure: EffectContract<void>;
    }) => EffectContract<void, PortableAgentStoreError>;
    readonly wait: (
      turnId: PortableTurnIdType,
    ) => EffectContract<Option.Option<PortableTurnTerminalProjection>, PortableAgentStoreError>;
    readonly observe: (
      capability: ObservationCapabilityType,
    ) => EffectContract<Option.Option<PortableTurnObservation>, PortableAgentStoreError>;
  }
>()("@caara/PortableAgentTurns") {}

/** Initial projections for a newly accepted portable turn. */
const initialProjectionState = (): ProjectionState => ({
  itemPhases: new Map(),
  terminal: { _tag: "Working" },
  observation: { status: "working", activity: "", finalAnswer: undefined },
});

/** Applies one runtime event to terminal and human projections without leaking activity. */
const projectRuntimeEvent = (state: ProjectionState, event: AgentRuntimeEvent): ProjectionState =>
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
      };
    },
    TurnFailed: (): ProjectionState => ({
      ...state,
      terminal: { _tag: "Failed" },
      observation: { ...state.observation, status: "failed" },
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

/** Persists both projections after one event without mixing capability data into turn state. */
const persistProjection = Effect.fnUntraced(function* ({
  store,
  record,
  turnId,
  current,
  event,
}: {
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly record: PortableTurnRecord;
  readonly turnId: PortableTurnIdType;
  readonly current: ProjectionState;
  readonly event: AgentRuntimeEvent;
}) {
  return yield* Option.match(Option.fromUndefinedOr(store), {
    onNone: () => Effect.void,
    onSome: (durable) =>
      Effect.gen(function* () {
        const updatedAtMillis = yield* Clock.currentTimeMillis;
        const durableState = Match.value(event._tag).pipe(
          Match.when("TurnSucceeded", () => ({
            _tag: "Completed" as const,
            finalAnswer: current.observation.finalAnswer ?? "",
          })),
          Match.when("TurnFailed", () => ({ _tag: "Failed" as const })),
          Match.orElse(() => ({ _tag: "Working" as const })),
        );
        yield* Effect.all(
          [
            durable.saveTurn({
              schemaVersion: 1,
              turnId,
              sessionId: record.sessionId,
              state: durableState,
              createdAtMillis: record.createdAtMillis,
              updatedAtMillis,
              expiresAtMillis: record.expiresAtMillis,
            }),
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
          ],
          { discard: true },
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
    Match.when({ _tag: "Cancelled" }, () => ({ _tag: "Failed" }) as const),
    Match.orElse(() => ({ _tag: "Working" }) as const),
  );

/** Maps durable cancellation into the viewer's failed terminal display. */
const recoveredObservationStatus = (
  status: "working" | "completed" | "failed" | "cancelled",
): PortableTurnObservation["status"] =>
  Match.value(status).pipe(
    Match.when("cancelled", () => "failed" as const),
    Match.orElse((value) => value),
  );

/** Live process-local implementation; durability and retention are intentionally deferred. */
const makePortableAgentTurns = ({
  store,
  retentionMillis = portableAgentRetentionMillis,
}: {
  readonly store: typeof PortableAgentStore.Service | undefined;
  readonly retentionMillis?: number;
}): typeof PortableAgentTurns.Service => {
  const records = new Map<PortableTurnIdType, PortableTurnRecord>();
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
      onRegistrationFailure,
    }: {
      readonly turnId: PortableTurnIdType;
      readonly sessionId: string;
      readonly capability: ObservationCapabilityType;
      readonly runtimeEvents: AgentRuntimeEventStream;
      readonly onRegistrationFailure: EffectContract<void>;
    }) {
      const createdAtMillis = yield* Clock.currentTimeMillis;
      const expiresAtMillis = createdAtMillis + retentionMillis;
      const state = yield* Ref.make(initialProjectionState());
      const record = { capability, sessionId, createdAtMillis, expiresAtMillis, state };
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
        yield* persistProjection({ store, record, turnId, current, event });
      });
      const persistRuntimeFailure = Effect.fnUntraced(function* (error: {
        readonly message: string;
      }) {
        const current = yield* Ref.updateAndGet(
          state,
          (projection): ProjectionState => ({
            ...projection,
            terminal: { _tag: "Failed" },
            observation: {
              ...projection.observation,
              status: "failed",
              activity: `${projection.observation.activity}${error.message}`,
            },
          }),
        );
        yield* persistStreamFailure({ store, record, turnId, current });
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
  };
};

/** Process-local registry shared by the live HTTP start, wait, and viewer routes. */
export const portableAgentTurnsProcessLocal = makePortableAgentTurns({ store: undefined });

/** Live process-local implementation; durability and retention are intentionally deferred. */
export const portableAgentTurnsLive = Layer.succeed(
  PortableAgentTurns,
  portableAgentTurnsProcessLocal,
);

/** Durable implementation backed by the configured portable Agent store. */
export const portableAgentTurnsDurableLive = Layer.effect(
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
    return makePortableAgentTurns({ store, retentionMillis });
  }),
);
