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

/** Runtime mapping knobs derived from parsed Antigravity driver options. */
export interface AntigravityTranscriptRuntimeOptions {
  readonly reasoning?: AntigravityRelayMode;
  readonly activity?: AntigravityRelayMode;
}

/** Safe Antigravity tool metadata fields allowed to influence activity text. */
interface AntigravityToolMetadata {
  readonly name?: string;
  readonly toolName?: string;
  readonly tool_name?: string;
  readonly type?: string;
  readonly path?: string;
  readonly filePath?: string;
  readonly file_path?: string;
  readonly toolSummary?: string;
  readonly toolAction?: string;
  readonly command?: string;
}

/** Stateful Antigravity transcript conversion position for stable runtime item ids. */
interface AntigravityRuntimeEventState {
  readonly nextReasoningIndex: number;
  readonly nextActivityIndex: number;
}

/** Result tuple returned while converting Antigravity transcript records. */
type AntigravityRuntimeEventResult = readonly [
  AntigravityRuntimeEventState,
  readonly AgentRuntimeEvent[],
];

/** Initial Antigravity runtime event conversion state for one transcript snapshot. */
const initialRuntimeEventState = (): AntigravityRuntimeEventState => ({
  nextReasoningIndex: 0,
  nextActivityIndex: 0,
});

/** Maximum safe metadata length surfaced in terse activity text. */
const maxActivityMetadataLength = 160;

/** Returns true when an optional string has displayable content. */
const isNonEmptyString = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

/** Returns the first non-empty optional string in a preferred metadata list. */
const firstNonEmptyString = (values: readonly (string | undefined)[]): string | undefined =>
  values.find(isNonEmptyString);

/** Normalizes one metadata value into a single line. */
const singleLineMetadata = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** Returns bounded path metadata, rejecting strings that look like raw JSON payloads. */
const safePathMetadata = (value: string | undefined): string | undefined =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(value).pipe(
      Option.map(singleLineMetadata),
      Option.filter(
        (metadata) =>
          metadata.length > 0 &&
          metadata.length <= maxActivityMetadataLength &&
          !/[{}]/u.test(metadata),
      ),
    ),
  );

/** Returns a bounded, single-line activity fallback summary when it is visibly terse. */
const safeActivitySummary = (value: string | undefined): string | undefined =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(value).pipe(
      Option.map(singleLineMetadata),
      Option.filter(
        (metadata) =>
          metadata.length > 0 &&
          metadata.length <= maxActivityMetadataLength &&
          !/[{}[\]"]/u.test(metadata),
      ),
    ),
  );

/** Extracts safe path-like metadata from an Antigravity transcript tool record. */
const safeToolPath = (metadata: AntigravityToolMetadata): string | undefined =>
  safePathMetadata(firstNonEmptyString([metadata.file_path, metadata.filePath, metadata.path]));

/** Extracts the preferred Antigravity tool name from safe metadata fields. */
const toolName = (metadata: AntigravityToolMetadata): string | undefined =>
  firstNonEmptyString([metadata.name, metadata.toolName, metadata.tool_name, metadata.type]);

/** Returns a bounded safe tool name for generic activity fallbacks. */
const safeToolName = (metadata: AntigravityToolMetadata): string =>
  safeActivitySummary(toolName(metadata)) ?? "tool";

/** Canonicalizes one Antigravity tool name for stable activity matching. */
const normalizedToolName = (metadata: AntigravityToolMetadata): string =>
  safeToolName(metadata)
    .replace(/[\s-]+/gu, "_")
    .toUpperCase();

/** Builds the user-facing activity phrase for one safe Antigravity tool metadata subset. */
const toolActivityText = (metadata: AntigravityToolMetadata): string => {
  const path = safeToolPath(metadata);
  return Match.value(normalizedToolName(metadata)).pipe(
    Match.when("LIST_DIRECTORY", () =>
      Option.match(Option.fromUndefinedOr(path), {
        onNone: () => "Listing directory",
        onSome: (directory) => `Listing ${directory}`,
      }),
    ),
    Match.when("VIEW_FILE", () =>
      Option.match(Option.fromUndefinedOr(path), {
        onNone: () => "Reading file",
        onSome: (filePath) => `Reading ${filePath}`,
      }),
    ),
    Match.when("RUN_COMMAND", () => "Running command"),
    Match.when("GREP_SEARCH", () =>
      Option.match(Option.fromUndefinedOr(path), {
        onNone: () => "Searching files",
        onSome: (filePath) => `Searching ${filePath}`,
      }),
    ),
    Match.orElse(
      () =>
        safeActivitySummary(metadata.toolAction) ??
        safeActivitySummary(metadata.toolSummary) ??
        `Using ${safeToolName(metadata)}`,
    ),
  );
};

/** Converts the Antigravity activity toggle into Responses transport visibility. */
const activityTransportVisibility = (
  activity: AntigravityRelayMode,
): AgentRuntimeTransportVisibility =>
  Match.value(activity).pipe(
    Match.when("off", () => "relay_only" as const),
    Match.orElse(() => "visible" as const),
  );

/** Returns the final completed planner response content, if present. */
const finalPlannerContentOption = (
  records: readonly AntigravityTranscriptRecord[],
): Option.Option<string> =>
  Option.fromUndefinedOr(
    records
      .filter(
        (record) =>
          record.source === "MODEL" &&
          record.type === "PLANNER_RESPONSE" &&
          record.status === "DONE" &&
          record.content !== undefined,
      )
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
    nextState = updatedState;
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
}): AntigravityRuntimeEventResult =>
  activityTextEvents({
    state,
    text: toolActivityText(record),
    transportVisibility,
  });

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
const runtimeEventsFromTranscriptRecords = ({
  records,
  reasoning,
  transportVisibility,
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
  readonly reasoning: AntigravityRelayMode;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): readonly AgentRuntimeEvent[] => {
  let state = initialRuntimeEventState();
  const events: AgentRuntimeEvent[] = [];
  for (const record of records) {
    const [nextState, nextEvents] = runtimeEventsFromTranscriptRecord({
      state,
      record,
      reasoning,
      transportVisibility,
    });
    state = nextState;
    events.push(...nextEvents);
  }
  return events;
};

/** Converts validated Antigravity transcript records into runtime lifecycle events. */
export const runtimeEventsFromAntigravityTranscript = Effect.fnUntraced(function* ({
  records,
  reasoning = "on",
  activity = "on",
}: {
  readonly records: readonly AntigravityTranscriptRecord[];
} & AntigravityTranscriptRuntimeOptions) {
  const content = yield* Option.match(finalPlannerContentOption(records), {
    onNone: () =>
      Effect.fail(
        new AgentDriverError({
          message: "Antigravity transcript did not contain a completed final model response.",
        }),
      ),
    onSome: Effect.succeed,
  });
  const transportVisibility = activityTransportVisibility(activity);
  const mappedEvents = runtimeEventsFromTranscriptRecords({
    records,
    reasoning,
    transportVisibility,
  });
  return [
    ...mappedEvents,
    ...createAssistantTextRuntimeEvents({
      itemId: "msg_antigravity_cli_final",
      text: content,
      messagePhase: "final_answer",
    }),
    createRuntimeTurnSucceededEvent(),
  ] satisfies readonly AgentRuntimeEvent[];
});
