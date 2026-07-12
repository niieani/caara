import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import { TestClock } from "effect/testing";

import { ObservationCapability, PortableTurnId } from "./portableAgentIdentity.ts";
import {
  PortableAgentStore,
  portableAgentStoreLive,
  type DurablePortableObservation,
  type DurablePortableTurn,
} from "./portableAgentStore.ts";

/** Creates a public-shape portable turn identity for durable store tests. */
const makePortableStoreTestTurnId = () => PortableTurnId.make(`portable-turn-${randomUUID()}`);

/** Creates an isolated state root under the project staging directory. */
const stateDir = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-12", `portable-store-${randomUUID()}`);

/** Builds a fresh platform-backed portable store for one test state root. */
const storeLayer = ({ root }: { readonly root: string }) =>
  portableAgentStoreLive({ stateDir: root }).pipe(Layer.provideMerge(BunServices.layer));

describe("PortableAgentStore", () => {
  it.effect("persists turns and capability observations in isolated directories", () => {
    const root = stateDir();
    const turnId = makePortableStoreTestTurnId();
    const capability = ObservationCapability.make("capability-secret");
    const accepted = {
      schemaVersion: 1,
      turnId,
      sessionId: "session-durable",
      state: { _tag: "Accepted" },
      createdAtMillis: 0,
      updatedAtMillis: 0,
      expiresAtMillis: 1_000,
    } satisfies DurablePortableTurn;
    const turn = {
      ...accepted,
      state: { _tag: "Completed", finalAnswer: "safe final" },
      updatedAtMillis: 10,
    } satisfies DurablePortableTurn;
    const observation = {
      schemaVersion: 1,
      capability,
      turnId,
      status: "completed",
      activity: "human-only sentinel",
      finalAnswer: "safe final",
      createdAtMillis: 0,
      updatedAtMillis: 10,
      expiresAtMillis: 1_000,
    } satisfies DurablePortableObservation;

    return Effect.gen(function* () {
      const store = yield* PortableAgentStore;
      yield* store.saveTurn(accepted);
      const directTerminal = yield* Effect.result(store.saveTurn(turn));
      assert.strictEqual(directTerminal._tag, "Failure");
      yield* store.saveTurn({ ...accepted, state: { _tag: "Working" }, updatedAtMillis: 5 });
      yield* store.saveTurn(turn);
      yield* store.saveObservation(observation);

      assert.deepStrictEqual(Option.getOrUndefined(yield* store.loadTurn(turnId)), turn);
      assert.deepStrictEqual(
        Option.getOrUndefined(yield* store.loadObservation(capability)),
        observation,
      );
      const fileSystem = yield* FileSystem.FileSystem;
      assert.strictEqual(yield* fileSystem.exists(path.join(root, "sessions")), false);
      assert.strictEqual(yield* fileSystem.exists(path.join(root, "portable-turns")), true);
      assert.strictEqual(yield* fileSystem.exists(path.join(root, "portable-observations")), true);
      const overwrite = yield* Effect.result(
        store.saveTurn({ ...accepted, state: { _tag: "Working" }, updatedAtMillis: 20 }),
      );
      assert.strictEqual(overwrite._tag, "Failure");
      const terminalRewrites = yield* Effect.forEach(
        [
          { _tag: "Accepted" } as const,
          { _tag: "Working" } as const,
          { _tag: "Completed", finalAnswer: "other" } as const,
          { _tag: "Failed" } as const,
          { _tag: "Cancelled", outcome: "Terminated", sessionReusable: false } as const,
        ],
        (state) => Effect.result(store.saveTurn({ ...accepted, state, updatedAtMillis: 30 })),
      );
      assert.ok(terminalRewrites.every((result) => result._tag === "Failure"));
      assert.deepStrictEqual(Option.getOrUndefined(yield* store.loadTurn(turnId)), turn);
    }).pipe(Effect.provide(storeLayer({ root })));
  });

  it.effect("expires portable records without deleting session bindings", () => {
    const root = stateDir();
    const turnId = makePortableStoreTestTurnId();
    const capability = ObservationCapability.make("capability-expiring");
    return Effect.gen(function* () {
      const store = yield* PortableAgentStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const sessionPath = path.join(root, "sessions", "diagnostic", "binding.json");
      yield* fileSystem.makeDirectory(path.dirname(sessionPath), { recursive: true });
      yield* fileSystem.writeFileString(sessionPath, "session binding sentinel");
      yield* store.saveTurn({
        schemaVersion: 1,
        turnId,
        sessionId: "session-expiring",
        state: { _tag: "Accepted" },
        createdAtMillis: 0,
        updatedAtMillis: 0,
        expiresAtMillis: 100,
      });
      yield* store.saveObservation({
        schemaVersion: 1,
        capability,
        turnId,
        status: "working",
        activity: "partial",
        createdAtMillis: 0,
        updatedAtMillis: 0,
        expiresAtMillis: 100,
      });
      yield* TestClock.adjust("101 millis");
      yield* store.cleanupExpired;

      assert.strictEqual((yield* store.loadTurn(turnId))._tag, "None");
      assert.strictEqual((yield* store.loadObservation(capability))._tag, "None");
      assert.strictEqual(
        yield* fileSystem.readFileString(sessionPath, "utf8"),
        "session binding sentinel",
      );
    }).pipe(Effect.provide(storeLayer({ root })));
  });
});
