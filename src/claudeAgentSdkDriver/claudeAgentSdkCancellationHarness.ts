import type {
  NonNullableUsage,
  Options as ClaudeQueryOptions,
  SDKMessage,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";
import { assert } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as Path from "effect/Path";

import {
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriverTurn,
} from "../mockResponsesProvider/agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
import type { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
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

/** Stable cwd used by SDK cancellation tests. */
const projectRoot = process.cwd();

/** Stable SDK session ids used by cancellation scenarios. */
export const cancellationScenarioIds = {
  beforeFirstEvent: "00000000-0000-4000-8000-00000000c101",
  afterPartialOutput: "00000000-0000-4000-8000-00000000c201",
  followUp: "00000000-0000-4000-8000-00000000c301",
  noResult: "00000000-0000-4000-8000-00000000c401",
  interruptFailure: "00000000-0000-4000-8000-00000000c501",
  streamFailure: "00000000-0000-4000-8000-00000000c601",
} as const;

/** SDK query request with non-optional options for assertions. */
export interface RecordedQueryRequest {
  readonly prompt: ClaudeAgentSdkQueryRequest["prompt"];
  readonly options: ClaudeQueryOptions;
}

/** Captured fake SDK runtime controls used to assert cancellation cleanup. */
export interface FakeSdkRuntimeControls {
  readonly interrupts: string[];
  readonly closes: string[];
  readonly nexts: string[];
}

/** Configures one fake SDK runtime's stream and cancellation behavior. */
export interface FakeSdkRuntimeConfig {
  readonly messages: readonly SDKMessage[];
  readonly interruptMessages?: readonly SDKMessage[];
  readonly interruptFailure?: Error;
  readonly streamFailure?: Error;
}

/** Builds the minimal non-null SDK usage payload required by result messages. */
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
    uuid: "00000000-0000-4000-8000-00000000c011",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds one fake SDK terminal result message. */
export const sdkResult = ({
  sessionId,
  terminalReason,
}: {
  readonly sessionId: string;
  readonly terminalReason: TerminalReason;
}) =>
  ({
    type: "result",
    subtype: "success",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: null,
    total_cost_usd: 0,
    usage: sdkUsage(),
    modelUsage: {},
    permission_denials: [],
    terminal_reason: terminalReason,
    uuid: "00000000-0000-4000-8000-00000000c012",
    session_id: sessionId,
  }) satisfies SDKMessage;

/** Builds a reusable interrupted cancellation outcome fixture. */
export const interruptedOutcome = (): AgentCancellationOutcome => ({
  _tag: "Interrupted",
  sessionReusable: true,
});

/** Builds a non-reusable terminated cancellation outcome fixture. */
export const terminatedOutcome = (): AgentCancellationOutcome => ({
  _tag: "Terminated",
  sessionReusable: false,
});

/** Builds a fake SDK query runtime with shared iterator state across stream consumers. */
const fakeRuntime = ({
  config,
  controls,
}: {
  readonly config: FakeSdkRuntimeConfig;
  readonly controls: FakeSdkRuntimeControls;
}): ClaudeAgentSdkQueryRuntime => {
  const pendingMessages: SDKMessage[] = [...config.messages];
  let index = 0;

  return {
    interrupt: () => {
      controls.interrupts.push("interrupt");
      pendingMessages.push(...(config.interruptMessages ?? []));
      return Option.match(Option.fromUndefinedOr(config.interruptFailure), {
        onNone: () => Promise.resolve(),
        onSome: (error) => Promise.reject(error),
      });
    },
    close: () => {
      controls.closes.push("close");
    },
    setModel: () => Promise.resolve(),
    setPermissionMode: () => Promise.resolve(),
    setMaxThinkingTokens: () => Promise.resolve(),
    [Symbol.asyncIterator]: () => ({
      next: () => {
        controls.nexts.push("next");
        const message = pendingMessages.at(index);
        index += 1;
        return Option.match(Option.fromUndefinedOr(message), {
          onNone: () =>
            Option.match(Option.fromUndefinedOr(config.streamFailure), {
              onNone: () =>
                Promise.resolve({
                  done: true,
                  value: undefined,
                } satisfies IteratorReturnResult<undefined>),
              onSome: (error) => Promise.reject(error),
            }),
          onSome: (nextMessage) =>
            Promise.resolve({
              done: false,
              value: nextMessage,
            } satisfies IteratorYieldResult<SDKMessage>),
        });
      },
    }),
  };
};

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

/** Builds one fake SDK cancellation harness from session ids and runtime configs. */
export const fakeSdkHarness = ({
  sessionIds,
  runtimeConfigs,
}: {
  readonly sessionIds: readonly string[];
  readonly runtimeConfigs: readonly FakeSdkRuntimeConfig[];
}) => {
  const recordedRequests: RecordedQueryRequest[] = [];
  const controls = runtimeConfigs.map(
    () =>
      ({
        interrupts: [],
        closes: [],
        nexts: [],
      }) satisfies FakeSdkRuntimeControls,
  );
  const runtimes = runtimeConfigs.map((config, index) => {
    const control = controls.at(index);
    assert.ok(control, "missing fake runtime controls");
    return fakeRuntime({ config, controls: control });
  });

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

/** Builds Codex identity context for one direct driver test turn. */
const makeCodex = ({ requestedCwd }: { readonly requestedCwd: string }): CodexTurnContext =>
  new CodexTurnContext({
    parentSessionId: "parent-session-sdk-cancel",
    threadId: "codex-thread-sdk-cancel",
    turnId: "turn-sdk-cancel",
    parentThreadId: "parent-thread-sdk-cancel",
    windowId: "window-sdk-cancel",
    requestKind: "turn",
    subagentKind: "caara",
    originator: "codex_cli_rs",
    requestedModel: "claude/sonnet",
    workspacePaths: [requestedCwd],
    cwdCandidates: [requestedCwd],
  });

/** Builds one selected Claude target for SDK cancellation tests. */
const makeTarget = (): AgentTarget =>
  new AgentTarget({
    requestedModel: "claude/sonnet",
    externalAgentKind: "claude",
    externalModelSpecifier: "sonnet",
    rawDriverOptions: {},
  });

/** Builds one direct driver turn with overridable durable session state. */
export const makeTurn = ({
  externalSession,
}: {
  readonly externalSession?: DurableExternalSession;
} = {}): AgentDriverTurn => ({
  codex: makeCodex({ requestedCwd: projectRoot }),
  target: makeTarget(),
  prompt: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "cancel this turn" }],
      },
    ],
  },
  cwd: projectRoot,
  requestedCwd: undefined,
  previousTarget: makeTarget(),
  externalSession,
});

/** Starts one SDK cancellation test turn through the injected fake registry. */
export const startDriverTurn = ({
  harness,
  turn,
}: {
  readonly harness: FakeSdkHarness;
  readonly turn: AgentDriverTurn;
}) =>
  Effect.gen(function* () {
    const registry = yield* AgentDriverRegistry;
    const driver = yield* registry.resolve(turn.target);
    return yield* driver.startOrResumeTurn(turn);
  }).pipe(Effect.provide(harness.layer));

/** Returns the first runtime controls from a one-runtime fake harness. */
export const firstControls = ({
  harness,
}: {
  readonly harness: FakeSdkHarness;
}): FakeSdkRuntimeControls => {
  const controls = harness.controls.at(0);
  assert.ok(controls, "missing fake runtime controls");
  return controls;
};
