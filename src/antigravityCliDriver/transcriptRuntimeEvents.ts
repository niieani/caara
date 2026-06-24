import { Effect, Match, Option } from "effect";

import {
  AgentDriverError,
  type AgentRuntimeEvent,
  type AgentRuntimeTransportVisibility,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import type { AntigravityRelayMode } from "./options.ts";
import type { AntigravityTranscriptRecord } from "./transcript.ts";
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
    records
      .filter(isFinalPlannerResponse)
      .map((record) => record.content)
      .at(-1),
  );

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
  const [toolResultState, toolResultEvents] = Match.value(
    record.source === "MODEL" &&
      ["LIST_DIRECTORY", "VIEW_FILE", "RUN_COMMAND", "GREP_SEARCH"].some(
        (type) => type === record.type,
      ) &&
      record.status === "DONE",
  ).pipe(
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
  for (const record of records) {
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
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
}) {
  const content = yield* Option.match(finalPlannerContentOption(records), {
    onNone: () =>
      Effect.fail(
        new AgentDriverError({
          message: "Antigravity transcript did not contain a completed final model response.",
        }),
      ),
    onSome: Effect.succeed,
  });
  return [
    ...createAssistantTextRuntimeEvents({
      itemId: "msg_antigravity_cli_final",
      text: content,
      messagePhase: "final_answer",
    }),
    createRuntimeTurnSucceededEvent(),
  ] satisfies readonly AgentRuntimeEvent[];
});

/** Converts validated Antigravity transcript records into runtime lifecycle events. */
export const runtimeEventsFromAntigravityTranscript = Effect.fnUntraced(function* ({
  records,
  reasoning = "on",
  activity = "on",
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
} & AntigravityTranscriptRuntimeOptions) {
  const [, mappedEvents] = runtimeEventsFromAntigravityTranscriptRecords({
    records,
    reasoning,
    activity,
  });
  const terminalEvents = yield* terminalRuntimeEventsFromAntigravityTranscript({ records });
  return [...mappedEvents, ...terminalEvents] satisfies readonly AgentRuntimeEvent[];
});
