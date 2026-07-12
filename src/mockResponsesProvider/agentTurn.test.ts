import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { runAgentTurn, type AgentTurnRequest } from "./agentTurn.ts";
import { AgentTarget } from "./codexTurnContext.ts";
import { diagnosticAgentDriverRegistryLive } from "./diagnosticDriver.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import { SessionDirectory, type CaaraSessionBinding } from "./sessionDirectory.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Builds the deterministic in-memory key used by the direct session directory fixture. */
const bindingStoreKey = ({
  externalAgentKind,
  driverInstanceId,
  codexThreadId,
}: CaaraSessionBinding["bindingKey"]): string =>
  `${externalAgentKind}:${driverInstanceId}:${codexThreadId}`;

/** Builds a transport-neutral Diagnostic request for a primary-seam test turn. */
const makeRequest = ({
  turnId,
  model = "basic",
}: {
  readonly turnId: string;
  readonly model?: string;
}): AgentTurnRequest => ({
  target: new AgentTarget({
    requestedModel: `diagnostic/${model}`,
    externalAgentKind: "diagnostic",
    externalModelSpecifier: model,
    rawDriverOptions: {},
  }),
  prompt: { input: "hello" },
  requestedCwd: "/workspace",
  identity: { sessionId: "session-1", parentSessionId: "parent-1", turnId },
  origin: { transport: "contract-test", metadata: { requestId: turnId } },
  advisories: { effort: undefined, sandboxPosture: "enforced" },
});

/** Creates a direct Agent Turn test layer and observable binding store. */
const directAgentTurnLayer = ({
  bindings,
  relayEvents = [],
}: {
  readonly bindings: Map<string, CaaraSessionBinding>;
  readonly relayEvents?: RelayLogEvent[];
}) =>
  Layer.mergeAll(
    diagnosticAgentDriverRegistryLive,
    turnConcurrencyLive,
    Layer.succeed(RelayLogger, {
      log: (event) => Effect.sync(() => relayEvents.push(event)).pipe(Effect.asVoid),
    }),
    Layer.succeed(SessionDirectory, {
      get: (key) => Effect.succeed(Option.fromUndefinedOr(bindings.get(bindingStoreKey(key)))),
      save: (binding) =>
        Effect.sync(() => bindings.set(bindingStoreKey(binding.bindingKey), binding)).pipe(
          Effect.asVoid,
        ),
      delete: (key) => Effect.sync(() => bindings.delete(bindingStoreKey(key))).pipe(Effect.asVoid),
    }),
  );

describe("AgentTurnRequest", () => {
  it.effect("is transport-neutral", () =>
    Effect.sync(() => {
      const request = {
        target: new AgentTarget({
          requestedModel: "diagnostic/basic",
          externalAgentKind: "diagnostic",
          externalModelSpecifier: "basic",
          rawDriverOptions: {},
        }),
        prompt: { input: "hello" },
        requestedCwd: "/workspace",
        identity: {
          sessionId: "thread-1",
          parentSessionId: "parent-1",
          turnId: "turn-1",
        },
        origin: {
          transport: "contract-test",
          metadata: { requestId: "request-1" },
        },
        advisories: {
          effort: undefined,
          sandboxPosture: "enforced",
        },
      } satisfies AgentTurnRequest;

      assert.strictEqual(request.origin.transport, "contract-test");
      assert.strictEqual(request.identity.sessionId, "thread-1");
      assert.ok(!("responses" in request));
      assert.ok(!("headers" in request));
    }),
  );
});

describe("runAgentTurn", () => {
  it.effect("completes first and resumed turns through the primary seam", () => {
    const bindings = new Map<string, CaaraSessionBinding>();
    return Effect.gen(function* () {
      const first = yield* runAgentTurn(makeRequest({ turnId: "turn-1" }));
      yield* Stream.runDrain(first.runtimeEvents);
      const resumed = yield* runAgentTurn(makeRequest({ turnId: "turn-2" }));
      yield* Stream.runDrain(resumed.runtimeEvents);

      assert.strictEqual(bindings.size, 1);
      assert.strictEqual([...bindings.values()][0]?.lastTurnId, "turn-2");
    }).pipe(Effect.provide(directAgentTurnLayer({ bindings })));
  });

  it.effect("single-flights explicit and stream cancellation before releasing the lease", () => {
    const bindings = new Map<string, CaaraSessionBinding>();
    const relayEvents: RelayLogEvent[] = [];
    return Effect.gen(function* () {
      const hanging = yield* runAgentTurn(
        makeRequest({ turnId: "turn-hang", model: "hangs-until-cancel" }),
      );
      const streamFiber = yield* Stream.runDrain(hanging.runtimeEvents).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      const conflict = yield* Effect.result(
        runAgentTurn(makeRequest({ turnId: "turn-conflict", model: "hangs-until-cancel" })),
      );
      assert.strictEqual(conflict._tag, "Failure");

      const cancellation = yield* hanging.cancel;
      assert.strictEqual(cancellation._tag, "Interrupted");
      const repeatedCancellation = yield* Effect.result(hanging.cancel);
      assert.strictEqual(repeatedCancellation._tag, "Failure");
      yield* Fiber.interrupt(streamFiber);
      assert.strictEqual(relayEvents.filter((event) => event._tag === "TurnCancelled").length, 1);

      const next = yield* runAgentTurn(makeRequest({ turnId: "turn-after-cancel" }));
      yield* Stream.runDrain(next.runtimeEvents);
      const completedCancellation = yield* Effect.result(next.cancel);
      assert.strictEqual(completedCancellation._tag, "Failure");
      assert.strictEqual(bindings.size, 1);
    }).pipe(Effect.provide(directAgentTurnLayer({ bindings, relayEvents })), Effect.scoped);
  });
});
