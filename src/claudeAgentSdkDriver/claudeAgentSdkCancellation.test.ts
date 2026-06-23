import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import {
  cancellationScenarioIds,
  fakeSdkHarness,
  firstControls,
  interruptedOutcome,
  makeTurn,
  sdkResult,
  sdkTextDelta,
  startDriverTurn,
  terminatedOutcome,
  type FakeSdkHarness,
  type FakeSdkRuntimeControls,
} from "./claudeAgentSdkCancellationHarness.ts";

/** Stable cwd used by SDK cancellation tests. */
const projectRoot = process.cwd();

/** Asserts the first fake runtime observed the expected cancellation control calls. */
const assertFirstControls = ({
  harness,
  expected,
}: {
  readonly harness: FakeSdkHarness;
  readonly expected: FakeSdkRuntimeControls;
}) => assert.deepStrictEqual(firstControls({ harness }), expected);

describe("Claude Agent SDK cancellation", () => {
  it.effect("interrupts and drains to an aborted result before first SDK event", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [cancellationScenarioIds.beforeFirstEvent],
        runtimeConfigs: [
          {
            messages: [],
            interruptMessages: [
              sdkResult({
                sessionId: cancellationScenarioIds.beforeFirstEvent,
                terminalReason: "aborted_streaming",
              }),
            ],
          },
        ],
      });
      const result = yield* startDriverTurn({ harness, turn: makeTurn() });

      const outcome = yield* result.cancel;

      assert.deepStrictEqual(outcome, interruptedOutcome());
      assertFirstControls({
        harness,
        expected: { interrupts: ["interrupt"], closes: [], nexts: ["next"] },
      });
    }),
  );

  it.effect("interrupts and drains after partial SDK output", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [cancellationScenarioIds.afterPartialOutput],
        runtimeConfigs: [
          {
            messages: [
              sdkTextDelta({
                sessionId: cancellationScenarioIds.afterPartialOutput,
                text: "partial",
              }),
            ],
            interruptMessages: [
              sdkResult({
                sessionId: cancellationScenarioIds.afterPartialOutput,
                terminalReason: "aborted_streaming",
              }),
            ],
          },
        ],
      });
      const result = yield* startDriverTurn({ harness, turn: makeTurn() });
      const partialEvents = yield* result.runtimeEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.map((chunk) => [...chunk]),
      );

      const outcome = yield* result.cancel;

      assert.deepStrictEqual(
        partialEvents.map((event) => event._tag),
        ["ItemCreated", "ContentStarted", "ContentDelta"],
      );
      assert.deepStrictEqual(outcome, interruptedOutcome());
      assertFirstControls({
        harness,
        expected: { interrupts: ["interrupt"], closes: [], nexts: ["next", "next"] },
      });
    }),
  );

  it.effect(
    "interrupts a follow-up query and keeps it reusable after an aborted-tools result",
    () =>
      Effect.gen(function* () {
        const harness = fakeSdkHarness({
          sessionIds: [],
          runtimeConfigs: [
            {
              messages: [],
              interruptMessages: [
                sdkResult({
                  sessionId: cancellationScenarioIds.followUp,
                  terminalReason: "aborted_tools",
                }),
              ],
            },
          ],
        });
        const result = yield* startDriverTurn({
          harness,
          turn: makeTurn({
            externalSession: new DurableExternalSession({
              driverResumeCursor: makeDriverResumeCursor(cancellationScenarioIds.followUp),
            }),
          }),
        });

        const outcome = yield* result.cancel;

        assert.deepStrictEqual(
          harness.recordedRequests.map((request) => request.options),
          [
            {
              cwd: projectRoot,
              model: "sonnet",
              resume: cancellationScenarioIds.followUp,
              includePartialMessages: true,
            },
          ],
        );
        assert.deepStrictEqual(outcome, interruptedOutcome());
        assertFirstControls({
          harness,
          expected: { interrupts: ["interrupt"], closes: [], nexts: ["next"] },
        });
      }),
  );

  it.effect(
    "closes and marks non-reusable when interruption reaches stream end without a result",
    () =>
      Effect.gen(function* () {
        const harness = fakeSdkHarness({
          sessionIds: [cancellationScenarioIds.noResult],
          runtimeConfigs: [
            {
              messages: [],
            },
          ],
        });
        const result = yield* startDriverTurn({ harness, turn: makeTurn() });

        const outcome = yield* result.cancel;

        assert.deepStrictEqual(outcome, terminatedOutcome());
        assertFirstControls({
          harness,
          expected: { interrupts: ["interrupt"], closes: ["close"], nexts: ["next"] },
        });
      }),
  );

  it.effect("closes and marks non-reusable when interrupt fails", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [cancellationScenarioIds.interruptFailure],
        runtimeConfigs: [
          {
            messages: [],
            interruptFailure: new Error("interrupt rejected"),
          },
        ],
      });
      const result = yield* startDriverTurn({ harness, turn: makeTurn() });

      const outcome = yield* result.cancel;

      assert.deepStrictEqual(outcome, terminatedOutcome());
      assertFirstControls({
        harness,
        expected: { interrupts: ["interrupt"], closes: ["close"], nexts: [] },
      });
    }),
  );

  it.effect("closes and marks non-reusable when the SDK stream fails while draining", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [cancellationScenarioIds.streamFailure],
        runtimeConfigs: [
          {
            messages: [],
            streamFailure: new Error("stream failed after interrupt"),
          },
        ],
      });
      const result = yield* startDriverTurn({ harness, turn: makeTurn() });

      const outcome = yield* result.cancel;

      assert.deepStrictEqual(outcome, terminatedOutcome());
      assertFirstControls({
        harness,
        expected: { interrupts: ["interrupt"], closes: ["close"], nexts: ["next"] },
      });
    }),
  );
});
