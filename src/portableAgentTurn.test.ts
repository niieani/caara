import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  createAssistantTextRuntimeEvents,
  createServerErrorAgentDriverError,
} from "./mockResponsesProvider/agentDriver.ts";
import { ObservationCapability, PortableTurnId } from "./portableAgentIdentity.ts";
import {
  PortableAgentStore,
  PortableAgentStoreError,
  portableAgentStoreLive,
} from "./portableAgentStore.ts";
import {
  PortableAgentTurns,
  portableAgentTurnsDurableLive,
  portableAgentTurnsLive,
} from "./portableAgentTurn.ts";

describe("PortableAgentTurns", () => {
  it.effect("treats an unphased assistant message as the final answer", () =>
    Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const turnId = PortableTurnId.make("turn-unphased");
      yield* turns.register({
        turnId,
        sessionId: "session-unphased",
        capability: ObservationCapability.make("unphased-capability"),
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
    const durableTurnsLayer = portableAgentTurnsDurableLive.pipe(Layer.provide(failingStore));
    return Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const cancelled = yield* Ref.make(false);
      const result = yield* Effect.result(
        turns.register({
          turnId: PortableTurnId.make("turn-registration-failure"),
          sessionId: "session-registration-failure",
          capability: ObservationCapability.make("registration-failure-capability"),
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
    const durableTurnsLayer = portableAgentTurnsDurableLive.pipe(
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
