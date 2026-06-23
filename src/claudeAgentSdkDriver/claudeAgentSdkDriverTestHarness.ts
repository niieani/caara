import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assert } from "@effect/vitest";
import { Effect, Layer, Match, Option, Stream } from "effect";
import * as Path from "effect/Path";

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

/** Builds one fake SDK stream text delta message. */
export const sdkTextDelta = ({
  sessionId,
  text,
}: {
  readonly sessionId: string;
  readonly text: string;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text,
      },
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000011",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK stream thinking delta message. */
export const sdkThinkingDelta = ({
  sessionId,
  thinking,
}: {
  readonly sessionId: string;
  readonly thinking: string;
}) =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
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
      Layer.provideMerge(fakeSdkClientLayer({ recordedRequests, runtimes })),
      Layer.provideMerge(fakeSessionIdLayer({ sessionIds })),
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
