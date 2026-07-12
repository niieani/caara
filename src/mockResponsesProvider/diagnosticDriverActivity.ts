import { Effect, Match, Option, Stream } from "effect";

import {
  createInvalidPromptAgentDriverError,
  type AgentDriverTurn,
  type AgentRuntimeEvent,
  createReasoningSummaryRuntimeEvents,
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
        createInvalidPromptAgentDriverError({
          message: `Diagnostic driver option diagnostic_activity must be on or off, received ${value}.`,
        }),
      ),
    ),
  );
});

/** Builds the diagnostic/activity runtime stream for commentary and final-answer coverage. */
export const createDiagnosticActivityRuntimeEventStream = Effect.fnUntraced(function* ({
  rawDriverOptions,
  turn,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly turn: AgentDriverTurn;
}) {
  const transportVisibility = yield* diagnosticActivityVisibility(rawDriverOptions);
  const sentinelEvents = Option.toArray(
    Option.fromUndefinedOr(rawDriverOptions.diagnostic_activity_sentinel),
  ).flatMap((sentinel) => [
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: "diagnostic-activity-sentinel-commentary",
      text: sentinel,
      chunkCount: 1,
      messagePhase: "commentary",
      transportVisibility,
    }),
    ...createReasoningSummaryRuntimeEvents({
      itemId: "diagnostic-activity-sentinel-reasoning",
      text: sentinel,
    }),
    {
      _tag: "PermissionDenied",
      toolName: "diagnostic-sentinel-tool",
      toolUseId: "diagnostic-sentinel-tool-use",
      message: sentinel,
      decisionReason: "diagnostic blindness fixture",
    } satisfies AgentRuntimeEvent,
  ]);
  return Stream.fromIterable([
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.activityReadingItemId,
      text: diagnosticDriverFixture.activityReadingText,
      chunkCount: 1,
      messagePhase: "commentary",
      transportVisibility,
    }),
    ...sentinelEvents,
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.activityEditingItemId,
      text: diagnosticDriverFixture.activityEditingText,
      chunkCount: 1,
      messagePhase: "commentary",
      transportVisibility,
    }),
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.activityAnswerItemId,
      text:
        turn.externalSession === undefined
          ? diagnosticDriverFixture.activityAnswerText
          : diagnosticDriverFixture.resumedActivityAnswerText,
      chunkCount: 1,
      messagePhase: "final_answer",
    }),
    createRuntimeTurnSucceededEvent(),
  ] satisfies readonly AgentRuntimeEvent[]);
});
