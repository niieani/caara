import { Effect, Match, Option, Schema } from "effect";

import { writeCaaraStructuredLogLine } from "../caaraLogging.ts";
import {
  AgentDriverError,
  type AgentRuntimeEvent,
  type AgentRuntimeTransportVisibility,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import type { AntigravityRelayMode } from "./options.ts";
import type {
  AntigravityTranscriptRecord,
  AntigravityTranscriptTelemetryContext,
} from "./transcript.ts";
import {
  appendPendingToolCall,
  completedToolActivityText,
  mergeToolMetadata,
  takePendingToolCall,
  toolActivityText,
  type AntigravityToolMetadata,
} from "./transcriptToolActivity.ts";

/** Runtime mapping knobs derived from parsed Antigravity driver options. */
export interface AntigravityTranscriptRuntimeOptions {
  readonly reasoning?: AntigravityRelayMode;
  readonly activity?: AntigravityRelayMode;
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}

/** Stateful Antigravity transcript conversion position for stable runtime item ids. */
export interface AntigravityRuntimeEventState {
  readonly nextReasoningIndex: number;
  readonly nextActivityIndex: number;
  readonly pendingToolCalls: readonly AntigravityToolMetadata[];
}

/** Result tuple returned while converting Antigravity transcript records. */
type AntigravityRuntimeEventResult = readonly [
  AntigravityRuntimeEventState,
  readonly AgentRuntimeEvent[],
];

/** Returns the provider-owned final answer used when Antigravity exits after tool activity. */
export function antigravityMissingFinalDiagnosticText(): string {
  return [
    "Antigravity completed without a final response after tool activity.",
    "Caara withheld raw tool output;",
    "check provider logs for caara.antigravity.transcript.missing_final_response.",
  ].join(" ");
}

/** Antigravity model result row types that represent completed known tool activity. */
const completedToolResultRecordTypes = [
  "LIST_DIRECTORY",
  "VIEW_FILE",
  "RUN_COMMAND",
  "GREP_SEARCH",
] as const;

/** Orders transcript rows by Antigravity semantic step index without mutating append-order state. */
export const orderAntigravityTranscriptRecordsByStepIndex = (
  records: readonly AntigravityTranscriptRecord[],
): readonly AntigravityTranscriptRecord[] =>
  records.toSorted((left, right) => left.step_index - right.step_index);

/** Initial Antigravity runtime event conversion state for one transcript snapshot. */
export const initialAntigravityRuntimeEventState = (): AntigravityRuntimeEventState => ({
  nextReasoningIndex: 0,
  nextActivityIndex: 0,
  pendingToolCalls: [],
});

/** Converts the Antigravity activity toggle into Responses transport visibility. */
const activityTransportVisibility = (
  activity: AntigravityRelayMode,
): AgentRuntimeTransportVisibility =>
  Match.value(activity).pipe(
    Match.when("off", () => "relay_only" as const),
    Match.orElse(() => "visible" as const),
  );

/** Returns whether one planner response can terminate the turn as the final answer. */
const isFinalPlannerResponse = (record: AntigravityTranscriptRecord): boolean =>
  record.source === "MODEL" &&
  record.type === "PLANNER_RESPONSE" &&
  record.status === "DONE" &&
  record.content !== undefined &&
  (record.tool_calls === undefined || record.tool_calls.length === 0);

/** Returns the final completed planner response content, if present. */
const finalPlannerContentOption = (
  records: readonly AntigravityTranscriptRecord[],
): Option.Option<string> =>
  Option.fromUndefinedOr(
    orderAntigravityTranscriptRecordsByStepIndex(records)
      .filter(isFinalPlannerResponse)
      .map((record) => record.content)
      .at(-1),
  );

/** Returns whether one record is a completed known Antigravity tool-result row. */
const isCompletedToolResultRecord = (record: AntigravityTranscriptRecord): boolean =>
  record.source === "MODEL" &&
  completedToolResultRecordTypes.some((type) => type === record.type) &&
  record.status === "DONE";

/** Returns whether one record is an opaque unknown model result row accepted by validation. */
const isOpaqueUnknownModelResultRecord = (record: AntigravityTranscriptRecord): boolean =>
  record.source === "MODEL" &&
  record.status === "DONE" &&
  record.content !== undefined &&
  record.type !== "PLANNER_RESPONSE" &&
  !completedToolResultRecordTypes.some((type) => type === record.type);

/** Returns whether one planner response contains tool calls but no final user answer. */
const isPlannerToolCallRecord = (record: AntigravityTranscriptRecord): boolean =>
  record.source === "MODEL" &&
  record.type === "PLANNER_RESPONSE" &&
  record.status === "DONE" &&
  record.tool_calls !== undefined &&
  record.tool_calls.length > 0;

/** Returns whether a transcript contains any tool activity without a final planner answer. */
const hasToolActivityWithoutFinalAnswer = (
  records: readonly AntigravityTranscriptRecord[],
): boolean =>
  Option.isNone(finalPlannerContentOption(records)) &&
  records.some(
    (record) =>
      isPlannerToolCallRecord(record) ||
      isCompletedToolResultRecord(record) ||
      isOpaqueUnknownModelResultRecord(record),
  );

/** Returns the last observed transcript step index for missing-final warning logs. */
const lastObservedStepIndex = (
  records: readonly AntigravityTranscriptRecord[],
): number | undefined =>
  orderAntigravityTranscriptRecordsByStepIndex(records)
    .map((record) => record.step_index)
    .at(-1);

/** Counts records that prove the missing-final transcript reached tool activity. */
const toolActivityRecordCount = (records: readonly AntigravityTranscriptRecord[]): number =>
  records.filter(
    (record) =>
      isPlannerToolCallRecord(record) ||
      isCompletedToolResultRecord(record) ||
      isOpaqueUnknownModelResultRecord(record),
  ).length;

/** Encodes one safe warning for a tool-only transcript that has no final response. */
const encodeMissingFinalTranscriptWarning = ({
  records,
  telemetryContext,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)({
    event: "caara.antigravity.transcript.missing_final_response",
    level: "warn",
    ...telemetryContext,
    recordCount: records.length,
    toolActivityRecordCount: toolActivityRecordCount(records),
    lastStepIndex: lastObservedStepIndex(records),
  });

/** Builds the terminal final-answer lifecycle for one Antigravity final text. */
const finalAnswerRuntimeEvents = (content: string): readonly AgentRuntimeEvent[] =>
  [
    ...createAssistantTextRuntimeEvents({
      itemId: "msg_antigravity_cli_final",
      text: content,
      messagePhase: "final_answer",
    }),
    createRuntimeTurnSucceededEvent(),
  ] satisfies readonly AgentRuntimeEvent[];

/** Fails with the legacy missing-final error for transcripts without tool activity. */
const missingFinalTranscriptFailure = Effect.fnUntraced(function* () {
  return yield* new AgentDriverError({
    message: "Antigravity transcript did not contain a completed final model response.",
  });
});

/** Logs and returns the safe diagnostic final answer for tool-only Antigravity exits. */
const missingFinalDiagnosticRuntimeEvents = Effect.fnUntraced(function* ({
  records,
  telemetryContext,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}) {
  yield* writeCaaraStructuredLogLine(
    encodeMissingFinalTranscriptWarning({ records, telemetryContext }),
  );
  return finalAnswerRuntimeEvents(antigravityMissingFinalDiagnosticText());
});

/** Builds one Antigravity reasoning item lifecycle and advances runtime state. */
const reasoningTextEvents = ({
  state,
  text,
}: {
  readonly state: AntigravityRuntimeEventState;
  readonly text: string;
}): AntigravityRuntimeEventResult => [
  {
    ...state,
    nextReasoningIndex: state.nextReasoningIndex + 1,
  },
  createReasoningSummaryRuntimeEvents({
    itemId: `antigravity-reasoning-${state.nextReasoningIndex}`,
    text,
  }),
];

/** Builds one Antigravity activity commentary item lifecycle and advances runtime state. */
const activityTextEvents = ({
  state,
  text,
  transportVisibility,
}: {
  readonly state: AntigravityRuntimeEventState;
  readonly text: string;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): AntigravityRuntimeEventResult => [
  {
    ...state,
    nextActivityIndex: state.nextActivityIndex + 1,
  },
  createAssistantTextRuntimeEvents({
    itemId: `antigravity-activity-${state.nextActivityIndex}`,
    text,
    messagePhase: "commentary",
    transportVisibility,
  }),
];

/** Returns no runtime events while preserving the current runtime mapping state. */
const noRuntimeEvents = (state: AntigravityRuntimeEventState): AntigravityRuntimeEventResult =>
  [state, []] as const;

/** Converts Antigravity planner tool calls into activity commentary events. */
const runtimeEventsFromToolCalls = ({
  state,
  record,
  transportVisibility,
}: {
  readonly state: AntigravityRuntimeEventState;
  readonly record: AntigravityTranscriptRecord;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): AntigravityRuntimeEventResult => {
  let nextState = state;
  const events: AgentRuntimeEvent[] = [];
  for (const toolCall of record.tool_calls ?? []) {
    const [updatedState, nextEvents] = activityTextEvents({
      state: nextState,
      text: toolActivityText(toolCall),
      transportVisibility,
    });
    nextState = {
      ...updatedState,
      pendingToolCalls: appendPendingToolCall({
        pendingToolCalls: updatedState.pendingToolCalls,
        toolCall,
      }),
    };
    events.push(...nextEvents);
  }
  return [nextState, events] as const;
};

/** Converts one completed Antigravity tool-result record into activity commentary events. */
const runtimeEventsFromCompletedToolRecord = ({
  state,
  record,
  transportVisibility,
}: {
  readonly state: AntigravityRuntimeEventState;
  readonly record: AntigravityTranscriptRecord;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): AntigravityRuntimeEventResult => {
  const pending = takePendingToolCall({
    pendingToolCalls: state.pendingToolCalls,
    record,
  });
  const pendingState = {
    ...state,
    pendingToolCalls: pending.pendingToolCalls,
  };
  const metadata = mergeToolMetadata({
    record,
    pendingToolCall: pending.toolCall,
  });
  const text = completedToolActivityText({
    record,
    metadata,
    hasPendingToolCall: pending.toolCall !== undefined,
  });
  return Option.match(Option.fromUndefinedOr(text), {
    onNone: () => noRuntimeEvents(pendingState),
    onSome: (activityText) =>
      activityTextEvents({
        state: pendingState,
        text: activityText,
        transportVisibility,
      }),
  });
};

/** Converts one Antigravity planner thinking field into reasoning events when enabled. */
const runtimeEventsFromPlannerThinking = ({
  state,
  thinking,
}: {
  readonly state: AntigravityRuntimeEventState;
  readonly thinking: string;
}): AntigravityRuntimeEventResult => reasoningTextEvents({ state, text: thinking });

/** Converts one validated Antigravity transcript record into non-final runtime events. */
const runtimeEventsFromTranscriptRecord = ({
  state,
  record,
  reasoning,
  transportVisibility,
}: {
  readonly state: AntigravityRuntimeEventState;
  readonly record: AntigravityTranscriptRecord;
  readonly reasoning: AntigravityRelayMode;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): AntigravityRuntimeEventResult => {
  const [toolCallState, toolCallEvents] = runtimeEventsFromToolCalls({
    state,
    record,
    transportVisibility,
  });
  const [toolResultState, toolResultEvents] = Match.value(isCompletedToolResultRecord(record)).pipe(
    Match.when(true, () =>
      runtimeEventsFromCompletedToolRecord({
        state: toolCallState,
        record,
        transportVisibility,
      }),
    ),
    Match.orElse(() => noRuntimeEvents(toolCallState)),
  );
  const [reasoningState, reasoningEvents] = Match.value(
    record.source === "MODEL" &&
      record.type === "PLANNER_RESPONSE" &&
      record.status === "DONE" &&
      record.thinking !== undefined &&
      reasoning === "on",
  ).pipe(
    Match.when(true, () =>
      runtimeEventsFromPlannerThinking({
        state: toolResultState,
        thinking: record.thinking ?? "",
      }),
    ),
    Match.orElse(() => noRuntimeEvents(toolResultState)),
  );
  return [reasoningState, [...toolCallEvents, ...toolResultEvents, ...reasoningEvents]] as const;
};

/** Converts all validated Antigravity transcript records into non-final runtime events. */
export const runtimeEventsFromAntigravityTranscriptRecords = ({
  records,
  reasoning = "on",
  activity = "on",
  state = initialAntigravityRuntimeEventState(),
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly reasoning?: AntigravityRelayMode;
  readonly activity?: AntigravityRelayMode;
  readonly state?: AntigravityRuntimeEventState;
}): readonly [AntigravityRuntimeEventState, readonly AgentRuntimeEvent[]] => {
  let currentState = state;
  const transportVisibility = activityTransportVisibility(activity);
  const events: AgentRuntimeEvent[] = [];
  for (const record of orderAntigravityTranscriptRecordsByStepIndex(records)) {
    const [nextState, nextEvents] = runtimeEventsFromTranscriptRecord({
      state: currentState,
      record,
      reasoning,
      transportVisibility,
    });
    currentState = nextState;
    events.push(...nextEvents);
  }
  return [currentState, events] as const;
};

/** Builds the terminal Antigravity final-answer lifecycle once the process exits. */
export const terminalRuntimeEventsFromAntigravityTranscript = Effect.fnUntraced(function* ({
  records,
  telemetryContext,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly telemetryContext?: AntigravityTranscriptTelemetryContext;
}) {
  return yield* Option.match(finalPlannerContentOption(records), {
    onNone: () =>
      Match.value(hasToolActivityWithoutFinalAnswer(records)).pipe(
        Match.when(true, () => missingFinalDiagnosticRuntimeEvents({ records, telemetryContext })),
        Match.orElse(missingFinalTranscriptFailure),
      ),
    onSome: (content) => Effect.succeed(finalAnswerRuntimeEvents(content)),
  });
});

/** Converts validated Antigravity transcript records into runtime lifecycle events. */
export const runtimeEventsFromAntigravityTranscript = Effect.fnUntraced(function* ({
  records,
  reasoning = "on",
  activity = "on",
  telemetryContext,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
} & AntigravityTranscriptRuntimeOptions) {
  const [, mappedEvents] = runtimeEventsFromAntigravityTranscriptRecords({
    records,
    reasoning,
    activity,
  });
  const terminalEvents = yield* terminalRuntimeEventsFromAntigravityTranscript({
    records,
    telemetryContext,
  });
  return [...mappedEvents, ...terminalEvents] satisfies readonly AgentRuntimeEvent[];
});
