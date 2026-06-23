import { Context, Effect, Layer, Option, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

/** Session key used by the in-flight turn guard. */
export interface TurnConcurrencyKey {
  readonly externalAgentKind: string;
  readonly codexThreadId: string;
}

/** Guard acquisition input for one incoming turn. */
export interface TurnConcurrencyAcquire {
  readonly key: TurnConcurrencyKey;
  readonly turnId: string;
}

/** Conflict raised when a session key already has an in-flight turn. */
export class TurnConcurrencyConflict extends Schema.TaggedErrorClass<TurnConcurrencyConflict>()(
  "TurnConcurrencyConflict",
  {
    message: Schema.String,
    externalAgentKind: Schema.String,
    codexThreadId: Schema.String,
    incomingTurnId: Schema.String,
    runningTurnId: Schema.String,
  },
) {}

/** Contract for releasing an acquired in-flight turn lease. */
export type TurnLeaseRelease = EffectContract<void>;

/** In-flight turn lease that must be released when turn processing exits. */
export interface TurnConcurrencyLease {
  readonly release: TurnLeaseRelease;
}

/** Contract for acquiring in-flight ownership for one turn. */
export type TurnConcurrencyAcquireEffect = (
  input: TurnConcurrencyAcquire,
) => EffectContract<TurnConcurrencyLease, TurnConcurrencyConflict>;

/** Service that enforces one in-flight turn per external-agent-kind and Codex thread. */
export class TurnConcurrency extends Context.Service<
  TurnConcurrency,
  {
    readonly acquire: TurnConcurrencyAcquireEffect;
  }
>()("@caara/TurnConcurrency") {}

/** Builds the stable map key for one in-flight turn guard entry. */
const concurrencyMapKey = ({ externalAgentKind, codexThreadId }: TurnConcurrencyKey): string =>
  `${externalAgentKind}:${codexThreadId}`;

/** Mutable process-local ownership table keyed by external-agent/thread session. */
interface TurnConcurrencyStore {
  readonly inFlightTurns: Map<string, string>;
}

/** Shared data needed to acquire or release one concrete turn lease. */
interface TurnLeaseOperation extends TurnConcurrencyStore {
  readonly mapKey: string;
  readonly turnId: string;
}

/** Clears an in-flight entry when this lease still owns the session key. */
const releaseTurnLease = Effect.fnUntraced(function* ({
  inFlightTurns,
  mapKey,
  turnId,
}: TurnLeaseOperation) {
  yield* Effect.sync(() =>
    Option.match(
      Option.fromUndefinedOr(inFlightTurns.get(mapKey)).pipe(
        Option.filter((currentTurnId) => currentTurnId === turnId),
      ),
      {
        onNone: () => undefined,
        onSome: () => inFlightTurns.delete(mapKey),
      },
    ),
  );
});

/** Records a newly accepted in-flight turn and returns its release lease. */
const acquireAvailableTurn = Effect.fnUntraced(function* (operation: TurnLeaseOperation) {
  yield* Effect.sync(() => operation.inFlightTurns.set(operation.mapKey, operation.turnId));
  return {
    release: releaseTurnLease(operation),
  } satisfies TurnConcurrencyLease;
});

/** Builds the typed conflict raised for an already-owned session key. */
const turnConcurrencyConflict = ({
  key,
  mapKey,
  incomingTurnId,
  runningTurnId,
}: {
  readonly key: TurnConcurrencyKey;
  readonly mapKey: string;
  readonly incomingTurnId: string;
  readonly runningTurnId: string;
}): TurnConcurrencyConflict =>
  new TurnConcurrencyConflict({
    message: `Session ${mapKey} already has an in-flight turn ${runningTurnId}.`,
    externalAgentKind: key.externalAgentKind,
    codexThreadId: key.codexThreadId,
    incomingTurnId,
    runningTurnId,
  });

/** Creates the process-local concurrency guard implementation. */
function makeTurnConcurrencyService() {
  const inFlightTurns = new Map<string, string>();

  return {
    acquire: Effect.fnUntraced(function* ({ key, turnId }: TurnConcurrencyAcquire) {
      const mapKey = concurrencyMapKey(key);
      const runningTurnId = Option.fromUndefinedOr(inFlightTurns.get(mapKey));

      return yield* Option.match(runningTurnId, {
        onNone: () =>
          acquireAvailableTurn({
            inFlightTurns,
            mapKey,
            turnId,
          }),
        onSome: (existingTurnId) =>
          turnConcurrencyConflict({
            key,
            mapKey,
            incomingTurnId: turnId,
            runningTurnId: existingTurnId,
          }),
      });
    }),
  };
}

/** Live in-memory concurrency guard for one Caara process. */
export const turnConcurrencyLive = Layer.sync(TurnConcurrency, makeTurnConcurrencyService);
