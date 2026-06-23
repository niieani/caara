import { Effect, Match, Stream } from "effect";

import {
  AgentDriverError,
  type AgentRuntimeEvent,
  createRuntimeTurnSucceededEvent,
} from "./agentDriver.ts";
import { diagnosticDriverFixture } from "./diagnosticDriverFixtures.ts";
import { createChunkedAssistantTextRuntimeEvents } from "./diagnosticDriverRuntimeEvents.ts";

/** Parses the bounded diagnostic/activity visibility option. */
const diagnosticActivityVisibility = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  return yield* Match.value(rawDriverOptions.diagnostic_activity ?? "on").pipe(
    Match.when("on", () => Effect.succeed("visible" as const)),
    Match.when("off", () => Effect.succeed("relay_only" as const)),
    Match.orElse((value) =>
      Effect.fail(
        new AgentDriverError({
          message: `Diagnostic driver option diagnostic_activity must be on or off, received ${value}.`,
        }),
      ),
    ),
  );
});

/** Builds the diagnostic/activity runtime stream for commentary and final-answer coverage. */
export const createDiagnosticActivityRuntimeEventStream = Effect.fnUntraced(function* ({
  rawDriverOptions,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
}) {
  const transportVisibility = yield* diagnosticActivityVisibility(rawDriverOptions);
  return Stream.fromIterable([
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.activityReadingItemId,
      text: diagnosticDriverFixture.activityReadingText,
      chunkCount: 1,
      messagePhase: "commentary",
      transportVisibility,
    }),
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.activityEditingItemId,
      text: diagnosticDriverFixture.activityEditingText,
      chunkCount: 1,
      messagePhase: "commentary",
      transportVisibility,
    }),
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.activityAnswerItemId,
      text: diagnosticDriverFixture.activityAnswerText,
      chunkCount: 1,
      messagePhase: "final_answer",
    }),
    createRuntimeTurnSucceededEvent(),
  ] satisfies readonly AgentRuntimeEvent[]);
});
