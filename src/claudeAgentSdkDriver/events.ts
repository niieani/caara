import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Match, Option, Schema, Stream } from "effect";

import {
  AgentDriverError,
  type AgentRuntimeEvent,
  type AgentRuntimeTransportVisibility,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import type { ClaudeAgentSdkQueryRuntime } from "./claudeAgentSdkClient.ts";
import {
  initialClaudeAgentSdkRuntimeEventState,
  type ClaudeAgentSdkRuntimeEventResult,
  type ClaudeAgentSdkRuntimeEventState,
} from "./claudeAgentSdkRuntimeEventState.ts";
import { resetClaudeAgentSdkStreamTracking, runtimeEventsFromStreamEvent } from "./streamEvents.ts";

/** SDK permission-denied message emitted after noninteractive permission rejection. */
type ClaudeAgentSdkPermissionDeniedMessage = Extract<
  SDKMessage,
  { readonly type: "system"; readonly subtype: "permission_denied" }
>;

/** Safe subset of SDK tool input fields used for terse activity summaries. */
const sdkToolInputSummarySchema = Schema.Struct({
  file_path: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
});

/** Safe subset of SDK tool_result content used for completion summaries. */
const sdkToolResultContentSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
});

/** Safe subset of SDK tool_result content used for completion summaries. */
type SdkToolResultContent = typeof sdkToolResultContentSchema.Type;

/** Builds the next stable assistant-message item id and advances message state. */
const assistantTextEvents = ({
  state,
  text,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly text: string;
}): ClaudeAgentSdkRuntimeEventResult => [
  {
    ...state,
    nextMessageIndex: state.nextMessageIndex + 1,
  },
  createAssistantTextRuntimeEvents({
    itemId: `claude-sdk-message-${state.nextMessageIndex}`,
    text,
    messagePhase: "final_answer",
  }),
];

/** Builds the next stable reasoning item id and advances reasoning state. */
const reasoningTextEvents = ({
  state,
  text,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly text: string;
}): ClaudeAgentSdkRuntimeEventResult => [
  {
    ...state,
    nextReasoningIndex: state.nextReasoningIndex + 1,
  },
  createReasoningSummaryRuntimeEvents({
    itemId: `claude-sdk-reasoning-${state.nextReasoningIndex}`,
    text,
  }),
];

/** Returns no runtime events for SDK messages outside the currently encoded subset. */
const noRuntimeEvents = (
  state: ClaudeAgentSdkRuntimeEventState,
): ClaudeAgentSdkRuntimeEventResult => [state, []] as const;

/** Builds one stable activity-commentary item id and advances activity state. */
const activityTextEvents = ({
  state,
  text,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly text: string;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): ClaudeAgentSdkRuntimeEventResult => [
  {
    ...state,
    nextActivityIndex: state.nextActivityIndex + 1,
  },
  createAssistantTextRuntimeEvents({
    itemId: `claude-sdk-activity-${state.nextActivityIndex}`,
    text,
    messagePhase: "commentary",
    transportVisibility,
  }),
];

/** Extracts a safe path-like hint from an SDK tool input object. */
const safeToolInputPath = (input: unknown): string | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(sdkToolInputSummarySchema)(input).pipe(
      Option.flatMap((summary) => Option.fromUndefinedOr(summary.file_path ?? summary.path)),
    ),
  );

/** Extracts typed tool_result content blocks from an SDK user message content payload. */
const sdkToolResultContents = (content: unknown): readonly SdkToolResultContent[] =>
  [content]
    .filter((candidate): candidate is readonly unknown[] => Array.isArray(candidate))
    .flatMap((items) => items.filter(Schema.is(sdkToolResultContentSchema)));

/** Builds a terse activity phrase for one SDK tool_use block. */
const toolUseActivityText = ({
  name,
  input,
}: {
  readonly name: string;
  readonly input: unknown;
}): string => {
  const path = safeToolInputPath(input);
  return Match.value(name).pipe(
    Match.when("Read", () =>
      Option.match(Option.fromUndefinedOr(path), {
        onNone: () => "Reading file",
        onSome: (filePath) => `Reading ${filePath}`,
      }),
    ),
    Match.when("Edit", () =>
      Option.match(Option.fromUndefinedOr(path), {
        onNone: () => "Editing file",
        onSome: (filePath) => `Editing ${filePath}`,
      }),
    ),
    Match.orElse((toolName) => `Using ${toolName}`),
  );
};

/** Builds a terse activity phrase for one SDK tool_result block. */
const toolResultActivityText = (toolName: string | undefined): string =>
  `${toolName ?? "Tool"} completed`;

/** Converts one SDK tool_use block into activity commentary events. */
const runtimeEventsFromToolUse = ({
  state,
  content,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly content: { readonly id: string; readonly name: string; readonly input: unknown };
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): ClaudeAgentSdkRuntimeEventResult => {
  const [nextState, events] = activityTextEvents({
    state,
    text: toolUseActivityText({ name: content.name, input: content.input }),
    transportVisibility,
  });
  return [
    {
      ...nextState,
      toolUseNames: {
        ...nextState.toolUseNames,
        [content.id]: content.name,
      },
    },
    events,
  ] as const;
};

/** Converts one SDK tool_result block into activity commentary events. */
const runtimeEventsFromToolResult = ({
  state,
  content,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly content: { readonly tool_use_id: string };
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): ClaudeAgentSdkRuntimeEventResult =>
  activityTextEvents({
    state,
    text: toolResultActivityText(state.toolUseNames[content.tool_use_id]),
    transportVisibility,
  });

/** Converts one SDK permission denial into a driver-neutral runtime event. */
const runtimeEventsFromPermissionDenied = ({
  state,
  message,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: ClaudeAgentSdkPermissionDeniedMessage;
}): ClaudeAgentSdkRuntimeEventResult => [
  state,
  [
    {
      _tag: "PermissionDenied",
      toolName: message.tool_name,
      toolUseId: message.tool_use_id,
      message: message.message,
      decisionReason: message.decision_reason,
    },
  ],
];

/** Returns true when final assistant content was already emitted through stream events. */
const isAlreadyStreamedAssistantContent = ({
  state,
  contentIndex,
  content,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly contentIndex: number;
  readonly content: Extract<
    SDKMessage,
    { readonly type: "assistant" }
  >["message"]["content"][number];
}): boolean =>
  state.streamedContentBlockIndexes.has(contentIndex) &&
  Match.value(content).pipe(
    Match.when({ type: "text" }, () => true),
    Match.when({ type: "thinking" }, () => true),
    Match.orElse(() => false),
  );

/** Converts a completed SDK assistant message into fallback text runtime events. */
const runtimeEventsFromAssistantMessage = ({
  state,
  message,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<SDKMessage, { readonly type: "assistant" }>;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): ClaudeAgentSdkRuntimeEventResult => {
  let nextState = state;
  const events: AgentRuntimeEvent[] = [];

  for (const [contentIndex, content] of message.message.content.entries()) {
    const [updatedState, nextEvents] = Match.value(content).pipe(
      Match.when(
        () => isAlreadyStreamedAssistantContent({ state: nextState, contentIndex, content }),
        () => noRuntimeEvents(nextState),
      ),
      Match.when({ type: "text" }, (textContent) =>
        assistantTextEvents({ state: nextState, text: textContent.text }),
      ),
      Match.when({ type: "thinking" }, (thinkingContent) =>
        reasoningTextEvents({ state: nextState, text: thinkingContent.thinking }),
      ),
      Match.when({ type: "tool_use" }, (toolUseContent) =>
        runtimeEventsFromToolUse({
          state: nextState,
          content: toolUseContent,
          transportVisibility,
        }),
      ),
      Match.orElse(() => noRuntimeEvents(nextState)),
    );
    nextState = updatedState;
    events.push(...nextEvents);
  }

  return [resetClaudeAgentSdkStreamTracking(nextState), events] as const;
};

/** Converts a user tool_result message into activity commentary when present. */
const runtimeEventsFromUserMessage = ({
  state,
  message,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<SDKMessage, { readonly type: "user" }>;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): ClaudeAgentSdkRuntimeEventResult => {
  let nextState = state;
  const events: AgentRuntimeEvent[] = [];
  for (const content of sdkToolResultContents(message.message.content)) {
    const [updatedState, nextEvents] = runtimeEventsFromToolResult({
      state: nextState,
      content,
      transportVisibility,
    });
    nextState = updatedState;
    events.push(...nextEvents);
  }
  return [nextState, events] as const;
};

/** Converts one SDK task-started message into terse activity commentary. */
const runtimeEventsFromTaskStarted = ({
  state,
  message,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<
    SDKMessage,
    { readonly type: "system"; readonly subtype: "task_started" }
  >;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): ClaudeAgentSdkRuntimeEventResult =>
  activityTextEvents({
    state,
    text: `Starting task: ${message.description}`,
    transportVisibility,
  });

/** Converts one SDK task-progress message into terse activity commentary. */
const runtimeEventsFromTaskProgress = ({
  state,
  message,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<
    SDKMessage,
    { readonly type: "system"; readonly subtype: "task_progress" }
  >;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}): ClaudeAgentSdkRuntimeEventResult =>
  activityTextEvents({
    state,
    text: message.summary ?? message.description,
    transportVisibility,
  });

/** Converts one SDK message into zero or more Caara runtime lifecycle events. */
const runtimeEventsFromSdkMessage = Effect.fnUntraced(function* ({
  state,
  message,
  transportVisibility,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: SDKMessage;
  readonly transportVisibility: AgentRuntimeTransportVisibility;
}) {
  return yield* Match.value(message).pipe(
    Match.when({ type: "stream_event" }, (sdkMessage) =>
      Effect.succeed(runtimeEventsFromStreamEvent({ state, message: sdkMessage })),
    ),
    Match.when({ type: "assistant" }, (sdkMessage) =>
      Effect.succeed(
        runtimeEventsFromAssistantMessage({
          state,
          message: sdkMessage,
          transportVisibility,
        }),
      ),
    ),
    Match.when({ type: "user" }, (sdkMessage) =>
      Effect.succeed(
        runtimeEventsFromUserMessage({
          state,
          message: sdkMessage,
          transportVisibility,
        }),
      ),
    ),
    Match.when({ type: "system", subtype: "task_started" }, (sdkMessage) =>
      Effect.succeed(
        runtimeEventsFromTaskStarted({
          state,
          message: sdkMessage,
          transportVisibility,
        }),
      ),
    ),
    Match.when({ type: "system", subtype: "task_progress" }, (sdkMessage) =>
      Effect.succeed(
        runtimeEventsFromTaskProgress({
          state,
          message: sdkMessage,
          transportVisibility,
        }),
      ),
    ),
    Match.when({ type: "result", subtype: "success" }, () =>
      Effect.succeed(noRuntimeEvents(state)),
    ),
    Match.when({ type: "result" }, (sdkMessage) =>
      Effect.fail(
        new AgentDriverError({
          message:
            sdkMessage.errors.at(0) ??
            `Claude Agent SDK failed with subtype ${sdkMessage.subtype}.`,
        }),
      ),
    ),
    Match.when({ type: "system", subtype: "permission_denied" }, (sdkMessage) =>
      Effect.succeed(runtimeEventsFromPermissionDenied({ state, message: sdkMessage })),
    ),
    Match.orElse(() => Effect.succeed(noRuntimeEvents(state))),
  );
});

/** Streams driver-neutral Caara runtime events from one Claude Agent SDK query runtime. */
export const runtimeEventsFromClaudeAgentSdkQuery = ({
  runtime,
  activityTransportVisibility = "visible",
}: {
  readonly runtime: ClaudeAgentSdkQueryRuntime;
  readonly activityTransportVisibility?: AgentRuntimeTransportVisibility;
}): Stream.Stream<AgentRuntimeEvent, AgentDriverError> =>
  Stream.fromAsyncIterable(
    runtime,
    (cause) => new AgentDriverError({ message: String(cause) }),
  ).pipe(
    Stream.mapAccumEffect(initialClaudeAgentSdkRuntimeEventState, (state, message) =>
      runtimeEventsFromSdkMessage({
        state,
        message,
        transportVisibility: activityTransportVisibility,
      }),
    ),
    Stream.concat(Stream.fromIterable([createRuntimeTurnSucceededEvent()])),
  );
