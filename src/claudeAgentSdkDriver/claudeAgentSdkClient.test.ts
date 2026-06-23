import type { Options as ClaudeQueryOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import {
  ClaudeAgentSdkClient,
  type ClaudeAgentSdkQueryRequest,
  type ClaudeAgentSdkQueryRuntime,
} from "./claudeAgentSdkClient.ts";

/** Query options used to prove the SDK-facing seam preserves typed option input. */
const queryOptions = {
  cwd: process.cwd(),
  model: "claude-sonnet-4-5",
  includePartialMessages: true,
  maxBudgetUsd: 0.25,
  sessionId: "sdk-session-contract",
} satisfies ClaudeQueryOptions;

/** SDK message emitted by the fake runtime through the imported SDK message union. */
const sdkSystemMessage = {
  type: "system",
  subtype: "init",
  apiKeySource: "user",
  claude_code_version: "2.1.186",
  cwd: process.cwd(),
  tools: [],
  mcp_servers: [],
  model: "claude-sonnet-4-5",
  permissionMode: "default",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "sdk-session-contract",
} satisfies SDKMessage;

/** Builds the terminal async-iterator result for a consumed fake SDK query. */
const fakeRuntimeDone = (): IteratorReturnResult<void> => ({
  done: true,
  value: undefined,
});

/** Builds one yielded async-iterator result for a fake SDK query message. */
const fakeRuntimeValue = (value: SDKMessage): IteratorYieldResult<SDKMessage> => ({
  done: false,
  value,
});

/** Builds a fake query runtime that can be consumed as an SDK message stream. */
const fakeQueryRuntime = ({
  messages,
}: {
  readonly messages: readonly SDKMessage[];
}): ClaudeAgentSdkQueryRuntime => ({
  interrupt: () => Promise.resolve(),
  close: () => undefined,
  setModel: () => Promise.resolve(),
  setPermissionMode: () => Promise.resolve(),
  setMaxThinkingTokens: () => Promise.resolve(),
  [Symbol.asyncIterator]: () => {
    let index = 0;
    return {
      next: () => {
        const message = messages.at(index);
        index += 1;
        return Promise.resolve(
          Option.match(Option.fromUndefinedOr(message), {
            onNone: fakeRuntimeDone,
            onSome: fakeRuntimeValue,
          }),
        );
      },
    };
  },
});

/** Builds an injectable fake SDK client layer and records every query request. */
const fakeClientLayer = ({
  recordedRequests,
}: {
  readonly recordedRequests: ClaudeAgentSdkQueryRequest[];
}) =>
  Layer.succeed(ClaudeAgentSdkClient, {
    query: (request) =>
      Effect.sync(() => recordedRequests.push(request)).pipe(
        Effect.map(() => fakeQueryRuntime({ messages: [sdkSystemMessage] })),
      ),
  });

/** Mutable test harness owned by one fake SDK client test invocation. */
interface FakeClientHarness {
  readonly recordedRequests: ClaudeAgentSdkQueryRequest[];
  readonly layer: ReturnType<typeof fakeClientLayer>;
}

/** Builds a fresh fake client harness for one test invocation. */
function fakeClientHarness(): FakeClientHarness {
  const recordedRequests: ClaudeAgentSdkQueryRequest[] = [];
  return {
    recordedRequests,
    layer: fakeClientLayer({ recordedRequests }),
  };
}

/** Runs the fake SDK client contract program with a fresh injected client layer. */
function runFakeClientContract({ recordedRequests, layer }: FakeClientHarness) {
  return Effect.gen(function* () {
    const client = yield* ClaudeAgentSdkClient;
    const runtime = yield* client.query({
      prompt: "contract prompt",
      options: queryOptions,
    });
    const emittedMessages = yield* Stream.fromAsyncIterable(runtime, String).pipe(
      Stream.runCollect,
    );

    assert.deepStrictEqual(recordedRequests, [
      {
        prompt: "contract prompt",
        options: queryOptions,
      },
    ]);
    assert.deepStrictEqual([...emittedMessages], [sdkSystemMessage]);
  }).pipe(Effect.provide(layer));
}

describe("Claude Agent SDK client service", () => {
  it.effect(
    "can be replaced by a fake query runtime that records options and emits SDK messages",
    () => Effect.sync(fakeClientHarness).pipe(Effect.flatMap(runFakeClientContract)),
  );
});
