import { Match, Option } from "effect";

import {
  type AgentRuntimeEvent,
  type AgentRuntimeMessagePhase,
  createAssistantTextRuntimeEvents,
} from "../mockResponsesProvider/agentDriver.ts";
import type {
  ClaudeAgentSdkPendingAssistantText,
  ClaudeAgentSdkRuntimeEventResult,
  ClaudeAgentSdkRuntimeEventState,
} from "./claudeAgentSdkRuntimeEventState.ts";

/** Returns whether pending text is the stream buffer for one SDK content index. */
const isPendingStreamTextForContentIndex = ({
  pendingText,
  contentIndex,
}: {
  readonly pendingText: ClaudeAgentSdkPendingAssistantText;
  readonly contentIndex: number;
}): boolean => pendingText._tag === "StreamText" && pendingText.contentIndex === contentIndex;

/** Appends text to a matching pending stream buffer and leaves other pending text unchanged. */
const appendToPendingStreamText = ({
  pendingText,
  contentIndex,
  text,
}: {
  readonly pendingText: ClaudeAgentSdkPendingAssistantText;
  readonly contentIndex: number;
  readonly text: string;
}): ClaudeAgentSdkPendingAssistantText =>
  Match.value(isPendingStreamTextForContentIndex({ pendingText, contentIndex })).pipe(
    Match.when(true, () => ({ ...pendingText, text: `${pendingText.text}${text}` })),
    Match.orElse(() => pendingText),
  );

/** Adds one phase-unknown assistant text chunk to the SDK runtime conversion buffer. */
export const bufferPendingAssistantText = ({
  state,
  pendingText,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly pendingText: ClaudeAgentSdkPendingAssistantText;
}): ClaudeAgentSdkRuntimeEventState => ({
  ...state,
  pendingAssistantTexts: [...state.pendingAssistantTexts, pendingText],
});

/** Appends one raw stream text delta to the pending stream-text buffer for a content index. */
export const appendPendingStreamAssistantText = ({
  state,
  contentIndex,
  text,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly contentIndex: number;
  readonly text: string;
}): ClaudeAgentSdkRuntimeEventState => {
  const existingStreamText = state.pendingAssistantTexts.find((pendingText) =>
    isPendingStreamTextForContentIndex({ pendingText, contentIndex }),
  );

  return Option.match(Option.fromUndefinedOr(existingStreamText), {
    onNone: () =>
      bufferPendingAssistantText({
        state,
        pendingText: { _tag: "StreamText", contentIndex, text },
      }),
    onSome: () => ({
      ...state,
      pendingAssistantTexts: state.pendingAssistantTexts.map((pendingText) =>
        appendToPendingStreamText({ pendingText, contentIndex, text }),
      ),
    }),
  });
};

/** Drops raw stream text buffers after a completed assistant message supersedes them. */
export const discardPendingStreamAssistantTexts = (
  state: ClaudeAgentSdkRuntimeEventState,
): ClaudeAgentSdkRuntimeEventState => ({
  ...state,
  pendingAssistantTexts: state.pendingAssistantTexts.filter(
    (pendingText) => pendingText._tag !== "StreamText",
  ),
});

/** Flushes phase-unknown assistant text once Claude exposes the owning message phase. */
export const flushPendingAssistantTexts = ({
  state,
  messagePhase,
}: {
  readonly state: ClaudeAgentSdkRuntimeEventState;
  readonly messagePhase: AgentRuntimeMessagePhase;
}): ClaudeAgentSdkRuntimeEventResult => {
  let nextMessageIndex = state.nextMessageIndex;
  const streamedContentBlockIndexes = new Set(state.streamedContentBlockIndexes);
  const events: AgentRuntimeEvent[] = [];

  for (const pendingText of state.pendingAssistantTexts) {
    Option.match(
      Match.value(pendingText).pipe(
        Match.when({ _tag: "StreamText" }, (streamText) => Option.some(streamText.contentIndex)),
        Match.orElse(() => Option.none<number>()),
      ),
      {
        onNone: () => undefined,
        onSome: (contentIndex) => streamedContentBlockIndexes.add(contentIndex),
      },
    );
    events.push(
      ...createAssistantTextRuntimeEvents({
        itemId: `claude-sdk-message-${nextMessageIndex}`,
        text: pendingText.text,
        messagePhase,
      }),
    );
    nextMessageIndex += 1;
  }

  return [
    {
      ...state,
      nextMessageIndex,
      pendingAssistantTexts: [],
      streamedContentBlockIndexes,
    },
    events,
  ] as const;
};
