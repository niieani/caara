import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Match, Stream } from "effect";

import {
  AgentDriverError,
  type AgentRuntimeEvent,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import type { ClaudeAgentSdkQueryRuntime } from "./claudeAgentSdkClient.ts";

/** Stateful SDK-message conversion position for stable Caara runtime item ids. */
interface ClaudeAgentSdkRuntimeEventState {
  readonly nextMessageIndex: number;
  readonly nextReasoningIndex: number;
}

/** Result tuple returned while incrementally converting SDK messages. */
type ClaudeAgentSdkRuntimeEventResult = readonly [
  ClaudeAgentSdkRuntimeEventState,
  readonly AgentRuntimeEvent[],
];

/** SDK content-block delta event emitted inside the partial assistant stream. */
type ClaudeAgentSdkContentBlockDeltaEvent = Extract<
  Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
  { readonly type: "content_block_delta" }
>;

/** SDK permission-denied message emitted after noninteractive permission rejection. */
type ClaudeAgentSdkPermissionDeniedMessage = Extract<
  SDKMessage,
  { readonly type: "system"; readonly subtype: "permission_denied" }
>;

/** Initial SDK-message conversion state for one query stream. */
const initialState = (): ClaudeAgentSdkRuntimeEventState => ({
  nextMessageIndex: 0,
  nextReasoningIndex: 0,
});

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

/** Converts one SDK content-block delta into runtime events. */
const runtimeEventsFromContentBlockDelta = ({
  state,
  event,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly event: ClaudeAgentSdkContentBlockDeltaEvent;
}): ClaudeAgentSdkRuntimeEventResult =>
  Match.value(event.delta).pipe(
    Match.when({ type: "text_delta" }, (delta) => assistantTextEvents({ state, text: delta.text })),
    Match.when({ type: "thinking_delta" }, (delta) =>
      reasoningTextEvents({ state, text: delta.thinking }),
    ),
    Match.orElse(() => noRuntimeEvents(state)),
  );

/** Converts one SDK stream event message into driver-neutral runtime events. */
const runtimeEventsFromStreamEvent = ({
  state,
  message,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<SDKMessage, { readonly type: "stream_event" }>;
}): ClaudeAgentSdkRuntimeEventResult =>
  Match.value(message.event).pipe(
    Match.when({ type: "content_block_delta" }, (event) =>
      runtimeEventsFromContentBlockDelta({ state, event }),
    ),
    Match.orElse(() => noRuntimeEvents(state)),
  );

/** Converts a completed SDK assistant message into fallback text runtime events. */
const runtimeEventsFromAssistantMessage = ({
  state,
  message,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: Extract<SDKMessage, { readonly type: "assistant" }>;
}): ClaudeAgentSdkRuntimeEventResult => {
  let nextState = state;
  const events: AgentRuntimeEvent[] = [];

  for (const content of message.message.content) {
    const [updatedState, nextEvents] = Match.value(content).pipe(
      Match.when({ type: "text" }, (textContent) =>
        assistantTextEvents({ state: nextState, text: textContent.text }),
      ),
      Match.when({ type: "thinking" }, (thinkingContent) =>
        reasoningTextEvents({ state: nextState, text: thinkingContent.thinking }),
      ),
      Match.orElse(() => noRuntimeEvents(nextState)),
    );
    nextState = updatedState;
    events.push(...nextEvents);
  }

  return [nextState, events] as const;
};

/** Converts one SDK message into zero or more Caara runtime lifecycle events. */
const runtimeEventsFromSdkMessage = Effect.fnUntraced(function* ({
  state,
  message,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly message: SDKMessage;
}) {
  return yield* Match.value(message).pipe(
    Match.when({ type: "stream_event" }, (sdkMessage) =>
      Effect.succeed(runtimeEventsFromStreamEvent({ state, message: sdkMessage })),
    ),
    Match.when({ type: "assistant" }, (sdkMessage) =>
      Effect.succeed(runtimeEventsFromAssistantMessage({ state, message: sdkMessage })),
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
}: {
  readonly runtime: ClaudeAgentSdkQueryRuntime;
}): Stream.Stream<AgentRuntimeEvent, AgentDriverError> =>
  Stream.fromAsyncIterable(
    runtime,
    (cause) => new AgentDriverError({ message: String(cause) }),
  ).pipe(
    Stream.mapAccumEffect(initialState, (state, message) =>
      runtimeEventsFromSdkMessage({ state, message }),
    ),
    Stream.concat(Stream.fromIterable([createRuntimeTurnSucceededEvent()])),
  );
