import { Context, Effect, Layer, Match, Option, Ref, Schema, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import type {
  AgentRuntimeEvent,
  AgentRuntimeEventStream,
} from "./mockResponsesProvider/agentDriver.ts";

/** Public identifier for one portable Agent turn. */
export const PortableTurnId = Schema.NonEmptyString.pipe(Schema.brand("PortableTurnId"));
/** Public identifier for one portable Agent turn. */
export type PortableTurnId = typeof PortableTurnId.Type;

/** Opaque human-viewer capability granting access to one turn observation. */
export const ObservationCapability = Schema.NonEmptyString.pipe(
  Schema.brand("ObservationCapability"),
);
/** Opaque human-viewer capability granting access to one turn observation. */
export type ObservationCapability = typeof ObservationCapability.Type;

/** Agent-facing coarse state while a portable turn remains active. */
export interface PortableTurnWorking {
  readonly _tag: "Working";
}

/** Agent-facing terminal state containing only the final answer. */
export interface PortableTurnCompleted {
  readonly _tag: "Completed";
  readonly finalAnswer: string;
}

/** Agent-facing projection intentionally excluding runtime observations. */
export type PortableTurnTerminalProjection = PortableTurnWorking | PortableTurnCompleted;

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
  readonly capability: ObservationCapability;
  readonly state: Ref.Ref<ProjectionState>;
}

/** Service exposing agent-safe terminal reads and capability-protected human observations. */
export class PortableAgentTurns extends Context.Service<
  PortableAgentTurns,
  {
    readonly register: (input: {
      readonly turnId: PortableTurnId;
      readonly capability: ObservationCapability;
      readonly runtimeEvents: AgentRuntimeEventStream;
    }) => EffectContract<void>;
    readonly wait: (
      turnId: PortableTurnId,
    ) => EffectContract<Option.Option<PortableTurnTerminalProjection>>;
    readonly observe: (
      capability: ObservationCapability,
    ) => EffectContract<Option.Option<PortableTurnObservation>>;
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

/** Live process-local implementation; durability and retention are intentionally deferred. */
const makePortableAgentTurns = (): typeof PortableAgentTurns.Service => {
  const records = new Map<PortableTurnId, PortableTurnRecord>();
  return {
    register: Effect.fnUntraced(function* ({
      turnId,
      capability,
      runtimeEvents,
    }: {
      readonly turnId: PortableTurnId;
      readonly capability: ObservationCapability;
      readonly runtimeEvents: AgentRuntimeEventStream;
    }) {
      const state = yield* Ref.make(initialProjectionState());
      yield* Effect.sync(() => records.set(turnId, { capability, state }));
      yield* runtimeEvents.pipe(
        Stream.runForEach((event) =>
          Ref.update(state, (current) => projectRuntimeEvent(current, event)),
        ),
        Effect.catch((error) =>
          Ref.update(
            state,
            (current): ProjectionState => ({
              ...current,
              observation: {
                ...current.observation,
                status: "failed",
                activity: `${current.observation.activity}${error.message}`,
              },
            }),
          ),
        ),
        Effect.forkDetach({ startImmediately: true }),
      );
    }),
    wait: (turnId) =>
      Option.match(Option.fromUndefinedOr(records.get(turnId)), {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (record) =>
          Ref.get(record.state).pipe(Effect.map((state) => Option.some(state.terminal))),
      }),
    observe: (capability) => {
      const record = [...records.values()].find((candidate) => candidate.capability === capability);
      return Option.match(Option.fromUndefinedOr(record), {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (found) =>
          Ref.get(found.state).pipe(Effect.map((state) => Option.some(state.observation))),
      });
    },
  };
};

/** Process-local registry shared by the live HTTP start, wait, and viewer routes. */
export const portableAgentTurnsProcessLocal = makePortableAgentTurns();

/** Live process-local implementation; durability and retention are intentionally deferred. */
export const portableAgentTurnsLive = Layer.succeed(
  PortableAgentTurns,
  portableAgentTurnsProcessLocal,
);
