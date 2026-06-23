import type { Options as ClaudeQueryOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Match, Option, Result, Stream } from "effect";

import {
  AgentDriverRegistry,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentRuntimeEvent,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import {
  ClaudeAgentSdkClient,
  ClaudeAgentSdkClientError,
  type ClaudeAgentSdkQueryRequest,
  type ClaudeAgentSdkQueryRuntime,
} from "./claudeAgentSdkClient.ts";
import {
  assertRequestsUseNonInteractivePermissionPolicy,
  queryRequestsWithoutPermissionPolicy,
} from "./claudeAgentSdkTestAssertions.ts";
import {
  ClaudeAgentSdkSessionIdGenerator,
  claudeAgentSdkAgentDriverRegistryLive,
} from "./driver.ts";

/** Stable cwd used by SDK driver tests. */
const projectRoot = process.cwd();

/** SDK query request with non-optional options for assertions. */
interface RecordedQueryRequest {
  readonly prompt: ClaudeAgentSdkQueryRequest["prompt"];
  readonly options: ClaudeQueryOptions;
}

/** Captured fake SDK runtime controls used to assert in-place option changes. */
interface FakeSdkRuntimeControls {
  readonly modelUpdates: string[];
  readonly interrupts: string[];
  readonly closes: string[];
}

/** Builds one fake SDK stream text delta message. */
const sdkTextDelta = ({ sessionId, text }: { readonly sessionId: string; readonly text: string }) =>
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
const sdkThinkingDelta = ({
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
  messages,
  controls,
}: {
  readonly messages: readonly SDKMessage[];
  readonly controls: FakeSdkRuntimeControls;
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
const fakeSdkHarness = ({
  sessionIds,
  runtimeMessages,
}: {
  readonly sessionIds: readonly string[];
  readonly runtimeMessages: readonly (readonly SDKMessage[])[];
}) => {
  const recordedRequests: RecordedQueryRequest[] = [];
  const controls = {
    modelUpdates: [],
    interrupts: [],
    closes: [],
  } satisfies FakeSdkRuntimeControls;
  const runtimes = runtimeMessages.map((messages) => fakeRuntime({ messages, controls }));

  return {
    recordedRequests,
    controls,
    layer: claudeAgentSdkAgentDriverRegistryLive.pipe(
      Layer.provideMerge(fakeSdkClientLayer({ recordedRequests, runtimes })),
      Layer.provideMerge(fakeSessionIdLayer({ sessionIds })),
    ),
  };
};

/** Mutable fake SDK harness state owned by one test invocation. */
type FakeSdkHarness = ReturnType<typeof fakeSdkHarness>;

/** Builds Codex identity context for one direct driver test turn. */
const makeCodex = ({ requestedCwd }: { readonly requestedCwd: string }): CodexTurnContext =>
  new CodexTurnContext({
    parentSessionId: "parent-session-sdk",
    threadId: "codex-thread-sdk",
    turnId: "turn-sdk",
    parentThreadId: "parent-thread-sdk",
    windowId: "window-sdk",
    requestKind: "turn",
    subagentKind: "caara",
    originator: "codex_cli_rs",
    requestedModel: "claude/sonnet",
    workspacePaths: [requestedCwd],
    cwdCandidates: [requestedCwd],
  });

/** Builds one selected Claude target with overridable model/options. */
const makeTarget = ({
  model = "sonnet",
  rawDriverOptions = {},
}: {
  readonly model?: string;
  readonly rawDriverOptions?: Readonly<Record<string, string>>;
} = {}): AgentTarget =>
  new AgentTarget({
    requestedModel: `claude/${model}`,
    externalAgentKind: "claude",
    externalModelSpecifier: model,
    rawDriverOptions,
  });

/** Builds one direct driver turn with latest-user prompt history. */
const makeTurn = ({
  target = makeTarget(),
  previousTarget,
  externalSession,
  cwd = projectRoot,
  requestedCwd = cwd,
}: {
  readonly target?: AgentTarget;
  readonly previousTarget?: AgentTarget;
  readonly externalSession?: DurableExternalSession;
  readonly cwd?: string;
  readonly requestedCwd?: string;
} = {}): AgentDriverTurn => ({
  codex: makeCodex({ requestedCwd }),
  target,
  prompt: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first request" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "previous answer" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow-up request" }],
      },
    ],
  },
  cwd,
  requestedCwd,
  previousTarget,
  externalSession,
});

/** Collects all runtime events emitted by one SDK driver turn. */
const runDriverTurn = ({
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
const durableCursor = (result: AgentDriverTurnResult): string =>
  Match.valueTags(result.externalSession, {
    Durable: (session) => session.driverResumeCursor,
    Ephemeral: () => assert.fail("expected durable external session"),
  });

describe("Claude Agent SDK driver", () => {
  it.effect(
    "starts a first-turn SDK query with prompt/options and maps assistant text deltas",
    () =>
      Effect.gen(function* () {
        const harness = fakeSdkHarness({
          sessionIds: ["00000000-0000-4000-8000-000000000101"],
          runtimeMessages: [
            [sdkTextDelta({ sessionId: "00000000-0000-4000-8000-000000000101", text: "hello" })],
          ],
        });
        const turn = makeTurn({
          target: makeTarget({
            rawDriverOptions: {
              effort: "max",
              max_budget_usd: "0.5",
              tools: "default",
            },
          }),
        });

        const { result, events } = yield* runDriverTurn({ harness, turn });

        assertRequestsUseNonInteractivePermissionPolicy(harness.recordedRequests);
        assert.deepStrictEqual(queryRequestsWithoutPermissionPolicy(harness.recordedRequests), [
          {
            prompt: "follow-up request",
            options: {
              cwd: projectRoot,
              model: "sonnet",
              sessionId: "00000000-0000-4000-8000-000000000101",
              includePartialMessages: true,
              effort: "max",
              maxBudgetUsd: 0.5,
              tools: { type: "preset", preset: "claude_code" },
            },
          },
        ]);
        assert.strictEqual(durableCursor(result), "00000000-0000-4000-8000-000000000101");
        assert.deepStrictEqual(events, [
          ...createAssistantTextRuntimeEvents({
            itemId: "claude-sdk-message-0",
            text: "hello",
          }),
          createRuntimeTurnSucceededEvent(),
        ] satisfies readonly AgentRuntimeEvent[]);
      }),
  );

  it.effect("resumes follow-up turns through the stored cursor and applies model changes", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [],
        runtimeMessages: [
          [
            sdkThinkingDelta({
              sessionId: "00000000-0000-4000-8000-000000000201",
              thinking: "plan",
            }),
          ],
        ],
      });
      const previousTarget = makeTarget({ model: "sonnet" });
      const target = makeTarget({
        model: "opus",
        rawDriverOptions: {
          effort: "low",
        },
      });
      const turn = makeTurn({
        target,
        previousTarget,
        externalSession: new DurableExternalSession({
          driverResumeCursor: makeDriverResumeCursor("00000000-0000-4000-8000-000000000201"),
        }),
      });

      const { result, events } = yield* runDriverTurn({ harness, turn });

      assertRequestsUseNonInteractivePermissionPolicy(harness.recordedRequests);
      assert.deepStrictEqual(queryRequestsWithoutPermissionPolicy(harness.recordedRequests), [
        {
          prompt: "follow-up request",
          options: {
            cwd: projectRoot,
            model: "opus",
            resume: "00000000-0000-4000-8000-000000000201",
            includePartialMessages: true,
            effort: "low",
          },
        },
      ]);
      assert.deepStrictEqual(harness.controls.modelUpdates, ["opus"]);
      assert.strictEqual(durableCursor(result), "00000000-0000-4000-8000-000000000201");
      assert.deepStrictEqual(events, [
        ...createReasoningSummaryRuntimeEvents({
          itemId: "claude-sdk-reasoning-0",
          text: "plan",
        }),
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("starts a fresh recovery session when cwd changes break continuity", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: ["00000000-0000-4000-8000-000000000302"],
        runtimeMessages: [[]],
      });
      const turn = makeTurn({
        cwd: "/old/project",
        requestedCwd: "/new/project",
        externalSession: new DurableExternalSession({
          driverResumeCursor: makeDriverResumeCursor("00000000-0000-4000-8000-000000000301"),
        }),
      });

      const { result, events } = yield* runDriverTurn({ harness, turn });

      assertRequestsUseNonInteractivePermissionPolicy(harness.recordedRequests);
      assert.deepStrictEqual(queryRequestsWithoutPermissionPolicy(harness.recordedRequests), [
        {
          prompt: lostSessionRecoveryDriverPrompt,
          options: {
            cwd: "/new/project",
            model: "sonnet",
            sessionId: "00000000-0000-4000-8000-000000000302",
            includePartialMessages: true,
          },
        },
      ]);
      assert.strictEqual(durableCursor(result), "00000000-0000-4000-8000-000000000302");
      assert.strictEqual(result.bindingCwd, "/new/project");
      assert.deepStrictEqual(result.lostSessionRecovery, {
        reason: "cwd-changed",
        diagnostics: {
          previousCwd: "/old/project",
          requestedCwd: "/new/project",
          previousCursor: "00000000-0000-4000-8000-000000000301",
        },
      });
      assert.deepStrictEqual(events, [] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("fails explicitly when fresh recovery session start fails", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: ["00000000-0000-4000-8000-000000000402"],
        runtimeMessages: [],
      });
      const turn = makeTurn({
        cwd: "/old/project",
        requestedCwd: "/new/project",
        externalSession: new DurableExternalSession({
          driverResumeCursor: makeDriverResumeCursor("00000000-0000-4000-8000-000000000401"),
        }),
      });

      const result = yield* Effect.result(runDriverTurn({ harness, turn }));

      Result.match(result, {
        onFailure: (error) => {
          assert.strictEqual(error._tag, "AgentDriverError");
          assert.match(error.message, /could not preserve Claude SDK session continuity/i);
        },
        onSuccess: () => assert.fail("expected recovery start failure"),
      });
    }),
  );
});
