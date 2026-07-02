import type {
  NonNullableUsage,
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assert } from "@effect/vitest";
import { Effect, Layer, Match, Option, Stream } from "effect";
import * as Path from "effect/Path";

import { caaraSettingsDefaultLayer } from "../caaraSettings.ts";
import {
  AgentDriverRegistry,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
} from "../mockResponsesProvider/agentDriver.ts";
import {
  ClaudeAgentSdkClient,
  ClaudeAgentSdkClientError,
  type ClaudeAgentSdkQueryRequest,
  type ClaudeAgentSdkQueryRuntime,
} from "./claudeAgentSdkClient.ts";
import {
  ClaudeAgentSdkSessionIdGenerator,
  claudeAgentSdkAgentDriverRegistryLive,
} from "./driver.ts";
import { ClaudeAgentSdkSettings } from "./settings.ts";

/** SDK query request with non-optional options for assertions. */
export interface RecordedQueryRequest {
  readonly prompt: ClaudeAgentSdkQueryRequest["prompt"];
  readonly options: ClaudeQueryOptions;
}

/** Collects a concrete SDK user-message async iterable. */
const collectPromptStream = (promptStream: AsyncIterable<SDKUserMessage>) =>
  Stream.fromAsyncIterable(promptStream, String).pipe(
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  );

/** Collects the SDK user-message prompt stream recorded by a fake query request. */
export const collectPromptMessages = Effect.fnUntraced(function* (
  prompt: ClaudeAgentSdkQueryRequest["prompt"],
) {
  return yield* Match.value(prompt).pipe(
    Match.when(
      (candidate): candidate is string => typeof candidate === "string",
      () => Effect.sync(() => assert.fail("expected SDKUserMessage prompt stream")),
    ),
    Match.orElse(collectPromptStream),
  );
});

/** Captured fake SDK runtime controls used to assert in-place option changes. */
export interface FakeSdkRuntimeControls {
  readonly modelUpdates: string[];
  readonly interrupts: string[];
  readonly closes: string[];
}

/** Builds the minimal non-null SDK usage payload required by assistant messages. */
const sdkUsage = (): NonNullableUsage => ({
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  inference_geo: "",
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  output_tokens_details: {
    thinking_tokens: 0,
  },
  server_tool_use: {
    web_fetch_requests: 0,
    web_search_requests: 0,
  },
  service_tier: "standard",
  speed: "standard",
});

/** Stop reason values carried by completed SDK assistant messages. */
type SdkAssistantStopReason = Extract<
  SDKMessage,
  { readonly type: "assistant" }
>["message"]["stop_reason"];

/** Stop reason values carried by raw SDK message-delta stream events. */
type SdkMessageDeltaStopReason = Extract<
  Extract<SDKMessage, { readonly type: "stream_event" }>["event"],
  { readonly type: "message_delta" }
>["delta"]["stop_reason"];

/** Builds one completed SDK assistant message containing text content. */
export const sdkAssistantTextMessage = ({
  sessionId,
  text,
  stopReason = "end_turn",
}: {
  readonly sessionId: string;
  readonly text: string;
  readonly stopReason?: SdkAssistantStopReason;
}) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_sdk_final_text",
      type: "message",
      container: null,
      context_management: null,
      diagnostics: null,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        {
          type: "text",
          text,
          citations: null,
        },
      ],
      stop_details: null,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: sdkUsage(),
    },
    uuid: "00000000-0000-4000-8000-000000000009",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one completed SDK assistant message containing a Bash tool_use block. */
export const sdkBashToolUseMessage = ({
  sessionId,
  command,
  toolUseId = "toolu_bash_command",
}: {
  readonly sessionId: string;
  readonly command: string;
  readonly toolUseId?: string;
}) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_sdk_bash_tool_use",
      type: "message",
      container: null,
      context_management: null,
      diagnostics: null,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command },
        },
      ],
      stop_details: null,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: sdkUsage(),
    },
    uuid: "00000000-0000-4000-8000-000000000109",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one completed SDK user message containing a tool_result block. */
export const sdkToolResultMessage = ({
  sessionId,
  toolUseId = "toolu_bash_command",
  content = "",
}: {
  readonly sessionId: string;
  readonly toolUseId?: string;
  readonly content?: string;
}) =>
  ({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
    tool_use_result: content,
    uuid: "00000000-0000-4000-8000-000000000110",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK raw message-delta event carrying the terminal stop reason. */
export const sdkMessageDelta = ({
  sessionId,
  stopReason,
}: {
  readonly sessionId: string;
  readonly stopReason: SdkMessageDeltaStopReason;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "message_delta",
      context_management: null,
      delta: {
        container: null,
        stop_details: null,
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        input_tokens: null,
        iterations: null,
        output_tokens: 0,
        output_tokens_details: null,
        server_tool_use: null,
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000111",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK successful terminal result message. */
export const sdkSuccessResultMessage = ({ sessionId }: { readonly sessionId: string }) =>
  ({
    type: "result",
    subtype: "success",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: sdkUsage(),
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000112",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK content-block start event for streamed assistant text. */
export const sdkTextBlockStart = ({
  sessionId,
  index = 0,
}: {
  readonly sessionId: string;
  readonly index?: number;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: {
        type: "text",
        text: "",
        citations: null,
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000010",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK stream text delta message. */
export const sdkTextDelta = ({
  sessionId,
  text,
  index = 0,
}: {
  readonly sessionId: string;
  readonly text: string;
  readonly index?: number;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: {
        type: "text_delta",
        text,
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000011",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK content-block start event for streamed displayable thinking. */
export const sdkThinkingBlockStart = ({
  sessionId,
  index = 0,
}: {
  readonly sessionId: string;
  readonly index?: number;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: {
        type: "thinking",
        thinking: "",
        signature: "",
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000012",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK stream thinking delta message. */
export const sdkThinkingDelta = ({
  sessionId,
  thinking,
  index = 0,
}: {
  readonly sessionId: string;
  readonly thinking: string;
  readonly index?: number;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: {
        type: "thinking_delta",
        thinking,
        estimated_tokens: null,
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000012",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK content-block stop event for a streamed content block. */
export const sdkContentBlockStop = ({
  sessionId,
  index = 0,
}: {
  readonly sessionId: string;
  readonly index?: number;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_stop",
      index,
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000013",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds a fake SDK query runtime that emits fixed messages and records controls. */
const fakeRuntime = ({
  controls,
  messages,
}: {
  readonly controls: FakeSdkRuntimeControls;
  readonly messages: readonly SDKMessage[];
}): ClaudeAgentSdkQueryRuntime => ({
  interrupt: () => {
    controls.interrupts.push("interrupt");
    return Promise.resolve();
  },
  close: () => {
    controls.closes.push("close");
  },
  setModel: (model?: string) => {
    controls.modelUpdates.push(model ?? "");
    return Promise.resolve();
  },
  setPermissionMode: () => Promise.resolve(),
  setMaxThinkingTokens: () => Promise.resolve(),
  [Symbol.asyncIterator]: () => {
    let index = 0;
    return {
      next: () => {
        const message = messages.at(index);
        index += 1;
        return Option.match(Option.fromUndefinedOr(message), {
          onNone: () =>
            Promise.resolve({ done: true, value: undefined } satisfies IteratorReturnResult<void>),
          onSome: (nextMessage) =>
            Promise.resolve({
              done: false,
              value: nextMessage,
            } satisfies IteratorYieldResult<SDKMessage>),
        });
      },
    };
  },
});

/** Builds an SDK client layer that records query requests and returns queued runtimes. */
const fakeSdkClientLayer = ({
  recordedRequests,
  runtimes,
}: {
  readonly recordedRequests: RecordedQueryRequest[];
  readonly runtimes: readonly ClaudeAgentSdkQueryRuntime[];
}) => {
  let runtimeIndex = 0;
  return Layer.succeed(ClaudeAgentSdkClient, {
    query: (request) =>
      Effect.sync(() => {
        const runtime = runtimes.at(runtimeIndex);
        runtimeIndex += 1;
        recordedRequests.push({
          prompt: request.prompt,
          options: request.options,
        });
        return runtime;
      }).pipe(
        Effect.flatMap((runtime) =>
          Option.match(Option.fromUndefinedOr(runtime), {
            onNone: () =>
              Effect.fail(new ClaudeAgentSdkClientError({ message: "no fake runtime" })),
            onSome: Effect.succeed,
          }),
        ),
      ),
  });
};

/** Builds a deterministic SDK session-id generator layer. */
const fakeSessionIdLayer = ({ sessionIds }: { readonly sessionIds: readonly string[] }) => {
  let sessionIndex = 0;
  return Layer.succeed(ClaudeAgentSdkSessionIdGenerator, {
    nextSessionId: Effect.sync(() => {
      const sessionId = sessionIds.at(sessionIndex);
      sessionIndex += 1;
      assert.ok(sessionId, "missing fake session id");
      return sessionId;
    }),
  });
};

/** Builds deterministic Claude SDK settings for fake driver tests. */
const fakeSettingsLayer = Layer.succeed(ClaudeAgentSdkSettings, {
  pathToClaudeCodeExecutable: Effect.sync(() => "/test/bin/claude"),
});

/** Builds one fake SDK driver harness from session ids and runtime messages. */
export const fakeSdkHarness = ({
  runtimeMessages,
  sessionIds,
}: {
  readonly runtimeMessages: readonly (readonly SDKMessage[])[];
  readonly sessionIds: readonly string[];
}) => {
  const recordedRequests: RecordedQueryRequest[] = [];
  const controls = {
    modelUpdates: [],
    interrupts: [],
    closes: [],
  } satisfies FakeSdkRuntimeControls;
  const runtimes = runtimeMessages.map((messages) => fakeRuntime({ controls, messages }));

  return {
    recordedRequests,
    controls,
    layer: claudeAgentSdkAgentDriverRegistryLive.pipe(
      Layer.provideMerge(caaraSettingsDefaultLayer),
      Layer.provideMerge(fakeSdkClientLayer({ recordedRequests, runtimes })),
      Layer.provideMerge(fakeSessionIdLayer({ sessionIds })),
      Layer.provideMerge(fakeSettingsLayer),
      Layer.provideMerge(Path.layer),
    ),
  };
};

/** Mutable fake SDK harness state owned by one test invocation. */
export type FakeSdkHarness = ReturnType<typeof fakeSdkHarness>;

/** Collects all runtime events emitted by one SDK driver turn. */
export const runDriverTurn = ({
  harness,
  turn,
}: {
  readonly harness: FakeSdkHarness;
  readonly turn: AgentDriverTurn;
}) =>
  Effect.gen(function* () {
    const registry = yield* AgentDriverRegistry;
    const driver = yield* registry.resolve(turn.target);
    const result = yield* driver.startOrResumeTurn(turn);
    const events = yield* result.runtimeEvents.pipe(
      Stream.runCollect,
      Effect.map((chunk) => [...chunk]),
    );

    return {
      result,
      events,
    };
  }).pipe(Effect.provide(harness.layer));

/** Extracts the driver resume cursor from a durable turn result. */
export const durableCursor = (result: AgentDriverTurnResult): string =>
  Match.valueTags(result.externalSession, {
    Durable: (session) => session.driverResumeCursor,
    Ephemeral: () => assert.fail("expected durable external session"),
  });
