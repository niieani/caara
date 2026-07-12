import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";

import { createAssistantTextRuntimeEvents } from "./mockResponsesProvider/agentDriver.ts";
import {
  ObservationCapability,
  PortableAgentTurns,
  PortableTurnId,
  portableAgentTurnsLive,
} from "./portableAgentTurn.ts";

describe("PortableAgentTurns", () => {
  it.effect("treats an unphased assistant message as the final answer", () =>
    Effect.gen(function* () {
      const turns = yield* PortableAgentTurns;
      const turnId = PortableTurnId.make("turn-unphased");
      yield* turns.register({
        turnId,
        capability: ObservationCapability.make("unphased-capability"),
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
      yield* turns.register({ turnId, capability, runtimeEvents: Stream.fromIterable(events) });
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
});
