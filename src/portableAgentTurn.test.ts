import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Match, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  createAssistantTextRuntimeEvents,
  createServerErrorAgentDriverError,
} from "./mockResponsesProvider/agentDriver.ts";
import { AgentTurnCancellationConflict } from "./mockResponsesProvider/agentTurn.ts";
import { ObservationCapability, PortableTurnId } from "./portableAgentIdentity.ts";
import {
  PortableAgentStore,
  PortableAgentStoreError,
  type DurablePortableObservation,
  type DurablePortableTurn,
  portableAgentStoreLive,
} from "./portableAgentStore.ts";
import {
  PortableAgentTurns,
  portableAgentTurnsDurableLive,
  portableAgentTurnsLive,
} from "./portableAgentTurn.ts";

/** Marks one injected write as consumed, then returns its typed failure. */
const consumeInjectedFailure = ({
  failed,
  message,
}: {
  readonly failed: Ref.Ref<boolean>;
  readonly message: string;
}) => {
  const failure = Effect.fail(new PortableAgentStoreError({ message }));
  return Ref.set(failed, true).pipe(Effect.andThen(failure));
};

/** Selects one injected failure or the successful in-memory persistence write. */
const injectedWrite = <A>({
  failed,
  message,
  shouldFail,
  target,
  value,
}: {
  readonly failed: Ref.Ref<boolean>;
  readonly message: string;
  readonly shouldFail: boolean;
  readonly target: Ref.Ref<Option.Option<A>>;
  readonly value: A;
}) =>
  Match.value(shouldFail).pipe(
    Match.when(true, () => consumeInjectedFailure({ failed, message })),
    Match.orElse(() => Ref.set(target, Option.some(value))),
  );

/** Builds an in-memory durable store with one injected cancellation-write failure. */
const cancellationFailureStore = Effect.fnUntraced(function* ({
  fail,
}: {
  readonly fail: "turn" | "observation" | "failedTurn" | "failedObservation";
}) {
  const turn = yield* Ref.make(Option.none<DurablePortableTurn>());
  const observation = yield* Ref.make(Option.none<DurablePortableObservation>());
  const failed = yield* Ref.make(false);
  const layer = Layer.succeed(PortableAgentStore, {
    saveTurn: (next) =>
      Ref.get(failed).pipe(
        Effect.flatMap((alreadyFailed) => {
          const shouldFail =
            ((fail === "turn" && next.state._tag === "Cancelled") ||
              (fail === "failedTurn" && next.state._tag === "Failed")) &&
            !alreadyFailed;
          return injectedWrite({
            failed,
            message: "injected turn failure",
            shouldFail,
            target: turn,
            value: next,
          });
        }),
      ),
    loadTurn: () => Ref.get(turn),
    saveObservation: (next) =>
      Ref.get(failed).pipe(
        Effect.flatMap((alreadyFailed) => {
          const shouldFail =
            ((fail === "observation" && next.status === "cancelled") ||
              (fail === "failedObservation" && next.status === "failed")) &&
            !alreadyFailed;
          return injectedWrite({
            failed,
            message: "injected observation failure",
            shouldFail,
            target: observation,
            value: next,
          });
        }),
      ),
    loadObservation: () => Ref.get(observation),
    deleteTurn: () => Ref.set(turn, Option.none()),
    deleteObservation: () => Ref.set(observation, Option.none()),
    cleanupExpired: Effect.void,
  });
  return { failed, layer, observation, turn };
});

describe("PortableAgentTurns", () => {
  it.effect(
    "makes a driver cancellation failure terminal instead of leaving cancelling state",
    () =>
      Effect.gen(function* () {
        const turns = yield* PortableAgentTurns;
        const turnId = PortableTurnId.make("portable-cancel-driver-failure");
        yield* turns.register({
          turnId,
          sessionId: "session-cancel-driver-failure",
          capability: ObservationCapability.make("capability-cancel-driver-failure"),
          runtimeEvents: Stream.never,
          cancel: Effect.fail(
            new AgentTurnCancellationConflict({ message: "injected driver cancellation failure" }),
          ),
          onRegistrationFailure: Effect.void,
        });

        assert.strictEqual((yield* Effect.result(turns.cancel(turnId)))._tag, "Failure");
        assert.deepStrictEqual(yield* turns.wait(turnId), Option.some({ _tag: "Failed" }));
        assert.strictEqual((yield* Effect.result(turns.cancel(turnId)))._tag, "Failure");
      }).pipe(Effect.provide(portableAgentTurnsLive)),
  );

  for (const failureKind of ["turn", "observation"] as const) {
    it.effect(`reconciles the first cancelled ${failureKind} persistence failure on retry`, () =>
      Effect.gen(function* () {
        const fixture = yield* cancellationFailureStore({ fail: failureKind });
        const layer = portableAgentTurnsDurableLive({ records: new Map() }).pipe(
          Layer.provide(fixture.layer),
        );
        const turnId = PortableTurnId.make(`portable-reconcile-${failureKind}`);
        const capability = ObservationCapability.make(`capability-reconcile-${failureKind}`);
        const cancelCalls = yield* Ref.make(0);
        const turns = yield* PortableAgentTurns.pipe(Effect.provide(layer));
        yield* turns.register({
          turnId,
          sessionId: `session-reconcile-${failureKind}`,
          capability,
          runtimeEvents: Stream.never,
          cancel: Ref.update(cancelCalls, (count) => count + 1).pipe(
            Effect.map(() => ({ _tag: "Interrupted", sessionReusable: true }) as const),
          ),
          onRegistrationFailure: Effect.void,
        });
        assert.strictEqual((yield* Effect.result(turns.cancel(turnId)))._tag, "Failure");
        assert.deepStrictEqual(yield* turns.cancel(turnId), {
          _tag: "Interrupted",
          sessionReusable: true,
        });
        assert.strictEqual(yield* Ref.get(cancelCalls), 1);
        assert.strictEqual(Option.getOrThrow(yield* Ref.get(fixture.turn)).state._tag, "Cancelled");
        assert.strictEqual(
          Option.getOrThrow(yield* Ref.get(fixture.observation)).status,
          "cancelled",
        );
        assert.deepStrictEqual(
          yield* turns.wait(turnId),
          Option.some({
            _tag: "Cancelled",
            outcome: "Interrupted",
            sessionReusable: true,
          }),
        );
      }),
    );
  }

  for (const failureKind of ["failedTurn", "failedObservation"] as const) {
    it.effect(`reconciles driver-cancel failure after injected ${failureKind} write failure`, () =>
      Effect.gen(function* () {
        const fixture = yield* cancellationFailureStore({ fail: failureKind });
        const layer = portableAgentTurnsDurableLive({ records: new Map() }).pipe(
          Layer.provide(fixture.layer),
        );
        const turnId = PortableTurnId.make(`portable-driver-failure-${failureKind}`);
        const turns = yield* PortableAgentTurns.pipe(Effect.provide(layer));
        yield* turns.register({
          turnId,
          sessionId: `session-driver-failure-${failureKind}`,
          capability: ObservationCapability.make(`capability-driver-failure-${failureKind}`),
          runtimeEvents: Stream.never,
          cancel: Effect.fail(
            new AgentTurnCancellationConflict({
              message: "injected driver cancellation failure",
            }),
          ),
          onRegistrationFailure: Effect.void,
        });
        assert.strictEqual((yield* Effect.result(turns.cancel(turnId)))._tag, "Failure");
        assert.strictEqual((yield* Effect.result(turns.cancel(turnId)))._tag, "Failure");
        assert.deepStrictEqual(yield* turns.wait(turnId), Option.some({ _tag: "Failed" }));
        assert.strictEqual(Option.getOrThrow(yield* Ref.get(fixture.turn)).state._tag, "Failed");
        assert.strictEqual(Option.getOrThrow(yield* Ref.get(fixture.observation)).status, "failed");
      }),
    );
  }

  it.effect("resolves gated cancellation and natural-completion races immutably", () => {
    const root = path.join(
      process.cwd(),
      "temp.local",
      "2026-07-12",
      `portable-race-${randomUUID()}`,
    );
    const durableLayer = () =>
      portableAgentTurnsDurableLive({ records: new Map() }).pipe(
        Layer.provide(portableAgentStoreLive({ stateDir: root })),
        Layer.provide(BunServices.layer),
      );
    const cancellationTurnId = PortableTurnId.make("portable-gated-cancel-wins");
    const cancellationCapability = ObservationCapability.make("capability-gated-cancel-wins");
    const completionTurnId = PortableTurnId.make("portable-gated-complete-wins");
    const completionCapability = ObservationCapability.make("capability-gated-complete-wins");
    const runRace = Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const cancellationGate = yield* Deferred.make<void>();
      yield* turns.register({
        turnId: cancellationTurnId,
        sessionId: "session-gated-cancel-wins",
        capability: cancellationCapability,
        runtimeEvents: Stream.fromEffect(Deferred.await(cancellationGate)).pipe(
          Stream.flatMap(() => Stream.fromIterable([{ _tag: "TurnSucceeded" } as const])),
        ),
        cancel: Deferred.await(cancellationGate).pipe(
          Effect.map(() => ({ _tag: "Interrupted", sessionReusable: true }) as const),
        ),
        onRegistrationFailure: Effect.void,
      });
      const cancelling = yield* turns.cancel(cancellationTurnId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(cancellationGate, undefined);
      assert.deepStrictEqual(yield* Fiber.join(cancelling), {
        _tag: "Interrupted",
        sessionReusable: true,
      });
      yield* Effect.yieldNow;
      assert.deepStrictEqual(
        yield* turns.wait(cancellationTurnId),
        Option.some({
          _tag: "Cancelled",
          outcome: "Interrupted",
          sessionReusable: true,
        }),
      );

      yield* turns.register({
        turnId: completionTurnId,
        sessionId: "session-gated-complete-wins",
        capability: completionCapability,
        runtimeEvents: Stream.fromIterable([{ _tag: "TurnSucceeded" } as const]),
        cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        onRegistrationFailure: Effect.void,
      });
      yield* Effect.yieldNow;
      assert.strictEqual((yield* Effect.result(turns.cancel(completionTurnId)))._tag, "Failure");
      assert.deepStrictEqual(
        yield* turns.wait(completionTurnId),
        Option.some({
          _tag: "Completed",
          finalAnswer: "",
        }),
      );
    }).pipe(Effect.provide(durableLayer()));
    const recoverFromDisk = Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      assert.deepStrictEqual(
        yield* turns.wait(cancellationTurnId),
        Option.some({ _tag: "Cancelled", outcome: "Interrupted", sessionReusable: true }),
      );
      assert.deepStrictEqual(
        yield* turns.observe(cancellationCapability),
        Option.some({
          status: "cancelled",
          activity: "",
          finalAnswer: undefined,
          cancellation: { outcome: "Interrupted", sessionReusable: true },
        }),
      );
      assert.deepStrictEqual(
        yield* turns.wait(completionTurnId),
        Option.some({ _tag: "Completed", finalAnswer: "" }),
      );
      assert.deepStrictEqual(
        yield* turns.observe(completionCapability),
        Option.some({ status: "completed", activity: "", finalAnswer: "" }),
      );
    }).pipe(Effect.provide(durableLayer()));
    return runRace.pipe(Effect.andThen(recoverFromDisk));
  });

  it.effect("persists one immutable cancellation outcome without leaking activity", () =>
    Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const turnId = PortableTurnId.make("portable-cancelled");
      const capability = ObservationCapability.make("portable-cancelled-capability");
      yield* turns.register({
        turnId,
        sessionId: "session-cancelled",
        capability,
        runtimeEvents: Stream.never,
        cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        onRegistrationFailure: Effect.void,
      });

      assert.deepStrictEqual(yield* turns.cancel(turnId), {
        _tag: "Interrupted",
        sessionReusable: true,
      });
      assert.deepStrictEqual(
        yield* turns.wait(turnId),
        Option.some({
          _tag: "Cancelled",
          outcome: "Interrupted",
          sessionReusable: true,
        }),
      );
      assert.deepStrictEqual(
        yield* turns.observe(capability),
        Option.some({
          status: "cancelled",
          activity: "",
          finalAnswer: undefined,
          cancellation: { outcome: "Interrupted", sessionReusable: true },
        }),
      );
      const repeated = yield* Effect.flip(turns.cancel(turnId));
      assert.strictEqual(repeated._tag, "PortableTurnCancellationConflict");
    }).pipe(Effect.provide(portableAgentTurnsLive)),
  );

  it.effect("keeps natural completion immutable when it wins cancellation", () =>
    Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const turnId = PortableTurnId.make("portable-natural-winner");
      yield* turns.register({
        turnId,
        sessionId: "session-natural-winner",
        capability: ObservationCapability.make("portable-natural-winner-capability"),
        runtimeEvents: Stream.fromIterable([{ _tag: "TurnSucceeded" } as const]),
        cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        onRegistrationFailure: Effect.void,
      });
      yield* Effect.yieldNow;

      const conflict = yield* Effect.flip(turns.cancel(turnId));
      assert.strictEqual(conflict._tag, "PortableTurnCancellationConflict");
      assert.deepStrictEqual(
        yield* turns.wait(turnId),
        Option.some({
          _tag: "Completed",
          finalAnswer: "",
        }),
      );
    }).pipe(Effect.provide(portableAgentTurnsLive)),
  );

  it.effect("treats an unphased assistant message as the final answer", () =>
    Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const turnId = PortableTurnId.make("turn-unphased");
      yield* turns.register({
        turnId,
        sessionId: "session-unphased",
        capability: ObservationCapability.make("unphased-capability"),
        cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        onRegistrationFailure: Effect.void,
        runtimeEvents: Stream.fromIterable([
          ...createAssistantTextRuntimeEvents({ itemId: "answer", text: "default final" }),
          { _tag: "TurnSucceeded" } as const,
        ]),
      });
      yield* Effect.yieldNow;

      assert.deepStrictEqual(Option.getOrUndefined(yield* turns.wait(turnId)), {
        _tag: "Completed",
        finalAnswer: "default final",
      });
    }).pipe(Effect.provide(portableAgentTurnsLive)),
  );

  it.effect("keeps commentary sentinel human-visible but agent-blind", () =>
    Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const turnId = PortableTurnId.make("turn-1");
      const capability = ObservationCapability.make("secret-capability");
      const events = [
        ...createAssistantTextRuntimeEvents({
          itemId: "commentary",
          text: "SENTINEL",
          messagePhase: "commentary",
        }),
        ...createAssistantTextRuntimeEvents({
          itemId: "final",
          text: "safe final",
          messagePhase: "final_answer",
        }),
        { _tag: "TurnSucceeded" } as const,
      ];
      yield* turns.register({
        turnId,
        sessionId: "session-1",
        capability,
        cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        onRegistrationFailure: Effect.void,
        runtimeEvents: Stream.fromIterable(events),
      });
      yield* Effect.yieldNow;
      const terminal = yield* turns.wait(turnId);
      const observation = yield* turns.observe(capability);
      assert.strictEqual(
        terminal.pipe((value) => value._tag),
        "Some",
      );
      assert.deepStrictEqual(Option.getOrUndefined(terminal), {
        _tag: "Completed",
        finalAnswer: "safe final",
      });
      assert.match(
        Option.match(observation, { onNone: () => "", onSome: (value) => value.activity }),
        /SENTINEL/,
      );
      assert.strictEqual(
        (yield* turns.observe(ObservationCapability.make("invalid")))._tag,
        "None",
      );
    }).pipe(Effect.provide(portableAgentTurnsLive)),
  );

  it.effect("projects runtime stream defects as terminal failures", () =>
    Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const turnId = PortableTurnId.make("turn-failed");
      yield* turns.register({
        turnId,
        sessionId: "session-failed",
        capability: ObservationCapability.make("failed-capability"),
        cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        onRegistrationFailure: Effect.void,
        runtimeEvents: Stream.fail(createServerErrorAgentDriverError({ message: "driver defect" })),
      });
      yield* Effect.yieldNow;

      assert.deepStrictEqual(Option.getOrUndefined(yield* turns.wait(turnId)), {
        _tag: "Failed",
      });
    }).pipe(Effect.provide(portableAgentTurnsLive)),
  );

  it.effect(
    "makes expired in-memory capabilities indistinguishable from invalid capabilities",
    () =>
      Effect.gen(function* () {
        const turns = yield* PortableAgentTurns;
        const turnId = PortableTurnId.make("turn-expired-memory");
        const capability = ObservationCapability.make("expired-memory-capability");
        yield* turns.register({
          turnId,
          sessionId: "session-expired-memory",
          capability,
          cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
          onRegistrationFailure: Effect.void,
          runtimeEvents: Stream.never,
        });
        yield* TestClock.adjust(7 * 24 * 60 * 60 * 1_000 + 1);

        assert.strictEqual((yield* turns.wait(turnId))._tag, "None");
        assert.strictEqual((yield* turns.observe(capability))._tag, "None");
        assert.strictEqual(
          (yield* turns.observe(ObservationCapability.make("invalid-memory-capability")))._tag,
          "None",
        );
      }).pipe(Effect.provide(portableAgentTurnsLive)),
  );

  it.effect("cancels ownership and rolls back when durable registration fails", () => {
    const failingStore = Layer.succeed(PortableAgentStore, {
      saveTurn: () =>
        Effect.fail(new PortableAgentStoreError({ message: "injected registration failure" })),
      loadTurn: () => Effect.succeed(Option.none()),
      saveObservation: () => Effect.void,
      loadObservation: () => Effect.succeed(Option.none()),
      deleteTurn: () =>
        Effect.fail(new PortableAgentStoreError({ message: "injected rollback failure" })),
      deleteObservation: () => Effect.void,
      cleanupExpired: Effect.void,
    });
    const durableTurnsLayer = portableAgentTurnsDurableLive({ records: new Map() }).pipe(
      Layer.provide(failingStore),
    );
    return Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const cancelled = yield* Ref.make(false);
      const result = yield* Effect.result(
        turns.register({
          turnId: PortableTurnId.make("turn-registration-failure"),
          sessionId: "session-registration-failure",
          capability: ObservationCapability.make("registration-failure-capability"),
          cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
          onRegistrationFailure: Ref.set(cancelled, true),
          runtimeEvents: Stream.never,
        }),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(yield* Ref.get(cancelled), true);
    }).pipe(Effect.provide(durableTurnsLayer));
  });

  it.effect("recovers durable failed streams as terminal failures", () => {
    const root = path.join(
      process.cwd(),
      "temp.local",
      "2026-07-12",
      `portable-failed-${randomUUID()}`,
    );
    const durableTurnsLayer = portableAgentTurnsDurableLive({ records: new Map() }).pipe(
      Layer.provide(portableAgentStoreLive({ stateDir: root })),
      Layer.provide(BunServices.layer),
    );
    const turnId = PortableTurnId.make("turn-durable-failed");
    const capability = ObservationCapability.make("durable-failed-capability");
    const registerFailure = Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      yield* turns.register({
        turnId,
        sessionId: "session-durable-failed",
        capability,
        cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        onRegistrationFailure: Effect.void,
        runtimeEvents: Stream.fail(
          createServerErrorAgentDriverError({ message: "durable stream defect" }),
        ),
      });
      yield* Effect.yieldNow;
    }).pipe(Effect.provide(durableTurnsLayer));
    const recoverFailure = Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      assert.deepStrictEqual(Option.getOrUndefined(yield* turns.wait(turnId)), {
        _tag: "Failed",
      });
      assert.deepStrictEqual(Option.getOrUndefined(yield* turns.observe(capability)), {
        status: "failed",
        activity: "durable stream defect",
        finalAnswer: undefined,
      });
    }).pipe(Effect.provide(durableTurnsLayer));
    return registerFailure.pipe(Effect.andThen(recoverFailure));
  });
});
import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
