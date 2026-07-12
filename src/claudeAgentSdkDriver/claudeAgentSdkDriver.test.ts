import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import {
  type AgentDriverTurn,
  type AgentRuntimeEvent,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import { agentTurnContextFromCodex } from "../mockResponsesProvider/codexAgentTurnContext.ts";
import {
  type CodexAdvisoryEffort,
  AgentTarget,
  CodexTurnContext,
} from "../mockResponsesProvider/codexTurnContext.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import {
  collectPromptMessages,
  durableCursor,
  fakeSdkHarness,
  runDriverTurn,
  sdkAssistantTextMessage,
  sdkBashToolUseMessage,
  sdkContentBlockStop,
  sdkMessageDelta,
  sdkSuccessResultMessage,
  sdkTextBlockStart,
  sdkTextDelta,
  sdkThinkingBlockStart,
  sdkThinkingDelta,
  sdkToolResultMessage,
} from "./claudeAgentSdkDriverTestHarness.ts";
import {
  assertRequestsUseNonInteractivePermissionPolicy,
  queryOptionsWithoutPermissionPolicy,
} from "./claudeAgentSdkTestAssertions.ts";

/** Stable cwd used by SDK driver tests. */
const projectRoot = process.cwd();

/** Stable SDK session id used by streamed text lifecycle coverage. */
const streamedTextSessionId = (): string => "00000000-0000-4000-8000-000000000102";

/** Stable SDK session id used by streamed thinking lifecycle coverage. */
const streamedThinkingSessionId = (): string => "00000000-0000-4000-8000-000000000202";

/** Stable SDK session id used by streamed/final assistant deduplication coverage. */
const streamedFinalDedupSessionId = (): string => "00000000-0000-4000-8000-000000000103";

/** Stable SDK session id used by assistant phase and activity mapping coverage. */
const assistantPhaseSessionId = (): string => "00000000-0000-4000-8000-000000000104";

/** Builds Codex identity context for one direct driver test turn. */
const makeCodex = ({
  advisoryEffort,
  requestedCwd,
}: {
  readonly advisoryEffort?: CodexAdvisoryEffort;
  readonly requestedCwd: string;
}): CodexTurnContext =>
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
    advisoryEffort,
    sandboxPosture: "enforced",
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

/** Builds one direct driver turn with core-normalized current-user prompt input. */
const makeTurn = ({
  target = makeTarget(),
  previousTarget,
  externalSession,
  cwd = projectRoot,
  requestedCwd = cwd,
  advisoryEffort,
}: {
  readonly target?: AgentTarget;
  readonly previousTarget?: AgentTarget;
  readonly externalSession?: DurableExternalSession;
  readonly cwd?: string;
  readonly requestedCwd?: string;
  readonly advisoryEffort?: CodexAdvisoryEffort;
} = {}): AgentDriverTurn => ({
  context: agentTurnContextFromCodex({ codex: makeCodex({ advisoryEffort, requestedCwd }) }),
  target,
  prompt: {
    input: [
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

describe("Claude Agent SDK driver", () => {
  it.effect(
    "starts a first-turn SDK query with prompt/options and maps assistant text deltas",
    () =>
      Effect.gen(function* () {
        const harness = fakeSdkHarness({
          sessionIds: ["00000000-0000-4000-8000-000000000101"],
          runtimeMessages: [
            [
              sdkTextDelta({
                sessionId: "00000000-0000-4000-8000-000000000101",
                text: "hello",
              }),
              sdkMessageDelta({
                sessionId: "00000000-0000-4000-8000-000000000101",
                stopReason: "end_turn",
              }),
            ],
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
        const request = harness.recordedRequests.at(0);
        assert.ok(request, "missing SDK query request");
        assert.strictEqual(request.options.pathToClaudeCodeExecutable, "/test/bin/claude");
        const promptMessages = yield* collectPromptMessages(request.prompt);

        assertRequestsUseNonInteractivePermissionPolicy(harness.recordedRequests);
        assert.deepStrictEqual(promptMessages, [
          {
            type: "user",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [{ type: "text", text: "follow-up request" }],
            },
          } satisfies SDKUserMessage,
        ]);
        assert.deepStrictEqual(
          harness.recordedRequests.map((recordedRequest) =>
            queryOptionsWithoutPermissionPolicy(recordedRequest.options),
          ),
          [
            {
              cwd: projectRoot,
              model: "sonnet",
              sessionId: "00000000-0000-4000-8000-000000000101",
              includePartialMessages: true,
              effort: "max",
              maxBudgetUsd: 0.5,
              tools: { type: "preset", preset: "claude_code" },
            },
          ],
        );
        assert.strictEqual(durableCursor(result), "00000000-0000-4000-8000-000000000101");
        assert.deepStrictEqual(events, [
          ...createAssistantTextRuntimeEvents({
            itemId: "claude-sdk-message-0",
            text: "hello",
            messagePhase: "final_answer",
          }),
          createRuntimeTurnSucceededEvent(),
        ] satisfies readonly AgentRuntimeEvent[]);
      }),
  );

  it.effect("uses Codex advisory effort when the Claude effort query option is absent", () =>
    Effect.gen(function* () {
      for (const effort of ["low", "medium", "high", "xhigh"] as const) {
        const harness = fakeSdkHarness({
          sessionIds: ["00000000-0000-4000-8000-000000000501"],
          runtimeMessages: [[]],
        });
        const turn = makeTurn({ advisoryEffort: effort });

        yield* runDriverTurn({ harness, turn });
        const request = harness.recordedRequests.at(0);
        assert.ok(request, "missing SDK query request");

        assert.strictEqual(queryOptionsWithoutPermissionPolicy(request.options).effort, effort);
      }
    }),
  );

  it.effect("keeps Claude effort query options above Codex advisory effort", () =>
    Effect.gen(function* () {
      for (const testCase of [
        { advisoryEffort: "xhigh", queryEffort: "max", expectedEffort: "max" },
        { advisoryEffort: "high", queryEffort: "low", expectedEffort: "low" },
      ] as const) {
        const harness = fakeSdkHarness({
          sessionIds: ["00000000-0000-4000-8000-000000000502"],
          runtimeMessages: [[]],
        });
        const turn = makeTurn({
          advisoryEffort: testCase.advisoryEffort,
          target: makeTarget({ rawDriverOptions: { effort: testCase.queryEffort } }),
        });

        yield* runDriverTurn({ harness, turn });
        const request = harness.recordedRequests.at(0);
        assert.ok(request, "missing SDK query request");

        assert.strictEqual(
          queryOptionsWithoutPermissionPolicy(request.options).effort,
          testCase.expectedEffort,
        );
      }
    }),
  );

  it.effect("rejects invalid Claude effort query options even with advisory effort present", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: ["00000000-0000-4000-8000-000000000503"],
        runtimeMessages: [[]],
      });
      const turn = makeTurn({
        advisoryEffort: "high",
        target: makeTarget({ rawDriverOptions: { effort: "turbo" } }),
      });

      const result = yield* Effect.result(runDriverTurn({ harness, turn }));

      Result.match(result, {
        onFailure: (error) => {
          assert.strictEqual(error._tag, "AgentDriverError");
          assert.match(error.message, /unsupported Claude Agent SDK effort/i);
        },
        onSuccess: () => assert.fail("expected effort query validation failure"),
      });
    }),
  );

  it.effect("uses completed assistant messages as the phase authority for streamed text", () =>
    Effect.gen(function* () {
      const sessionId = streamedTextSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkTextBlockStart({ sessionId }),
            sdkTextDelta({ sessionId, text: "hel" }),
            sdkTextDelta({ sessionId, text: "lo" }),
            sdkContentBlockStop({ sessionId }),
            sdkAssistantTextMessage({ sessionId, text: "hello", stopReason: "end_turn" }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        {
          _tag: "ItemCreated",
          itemId: "claude-sdk-message-0",
          itemKind: "assistant_message",
          messagePhase: "final_answer",
        },
        {
          _tag: "ContentStarted",
          itemId: "claude-sdk-message-0",
          contentIndex: 0,
          contentKind: "assistant_text",
        },
        {
          _tag: "ContentDelta",
          itemId: "claude-sdk-message-0",
          contentIndex: 0,
          contentKind: "assistant_text",
          text: "hello",
        },
        {
          _tag: "ContentCompleted",
          itemId: "claude-sdk-message-0",
          contentIndex: 0,
          contentKind: "assistant_text",
        },
        {
          _tag: "ItemCompleted",
          itemId: "claude-sdk-message-0",
        },
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("keeps streamed thinking deltas in one reasoning item lifecycle", () =>
    Effect.gen(function* () {
      const sessionId = streamedThinkingSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkThinkingBlockStart({ sessionId }),
            sdkThinkingDelta({ sessionId, thinking: "pl" }),
            sdkThinkingDelta({ sessionId, thinking: "an" }),
            sdkContentBlockStop({ sessionId }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        {
          _tag: "ItemCreated",
          itemId: "claude-sdk-reasoning-0",
          itemKind: "reasoning",
        },
        {
          _tag: "ContentStarted",
          itemId: "claude-sdk-reasoning-0",
          contentIndex: 0,
          contentKind: "reasoning_summary_text",
        },
        {
          _tag: "ContentDelta",
          itemId: "claude-sdk-reasoning-0",
          contentIndex: 0,
          contentKind: "reasoning_summary_text",
          text: "pl",
        },
        {
          _tag: "ContentDelta",
          itemId: "claude-sdk-reasoning-0",
          contentIndex: 0,
          contentKind: "reasoning_summary_text",
          text: "an",
        },
        {
          _tag: "ContentCompleted",
          itemId: "claude-sdk-reasoning-0",
          contentIndex: 0,
          contentKind: "reasoning_summary_text",
        },
        {
          _tag: "ItemCompleted",
          itemId: "claude-sdk-reasoning-0",
        },
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("does not duplicate final assistant text already emitted from stream blocks", () =>
    Effect.gen(function* () {
      const sessionId = streamedFinalDedupSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkTextBlockStart({ sessionId }),
            sdkTextDelta({ sessionId, text: "hello" }),
            sdkContentBlockStop({ sessionId }),
            sdkAssistantTextMessage({ sessionId, text: "hello" }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        {
          _tag: "ItemCreated",
          itemId: "claude-sdk-message-0",
          itemKind: "assistant_message",
          messagePhase: "final_answer",
        },
        {
          _tag: "ContentStarted",
          itemId: "claude-sdk-message-0",
          contentIndex: 0,
          contentKind: "assistant_text",
        },
        {
          _tag: "ContentDelta",
          itemId: "claude-sdk-message-0",
          contentIndex: 0,
          contentKind: "assistant_text",
          text: "hello",
        },
        {
          _tag: "ContentCompleted",
          itemId: "claude-sdk-message-0",
          contentIndex: 0,
          contentKind: "assistant_text",
        },
        {
          _tag: "ItemCompleted",
          itemId: "claude-sdk-message-0",
        },
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("maps pre-tool assistant text to commentary and includes Bash command detail", () =>
    Effect.gen(function* () {
      const sessionId = assistantPhaseSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkAssistantTextMessage({
              sessionId,
              text: "Let me verify before answering.",
              stopReason: "tool_use",
            }),
            sdkBashToolUseMessage({
              sessionId,
              command: "find src -type f -name '*.tst.ts'",
            }),
            sdkToolResultMessage({ sessionId, content: "(Bash completed with no output)" }),
            sdkAssistantTextMessage({
              sessionId,
              text: "There are no type-test files.",
              stopReason: "end_turn",
            }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-message-0",
          text: "Let me verify before answering.",
          messagePhase: "commentary",
        }),
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-activity-0",
          text: "Using Bash: `find src -type f -name '*.tst.ts'`",
          messagePhase: "commentary",
          transportVisibility: "visible",
        }),
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-activity-1",
          text: "Bash completed",
          messagePhase: "commentary",
          transportVisibility: "visible",
        }),
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-message-1",
          text: "There are no type-test files.",
          messagePhase: "final_answer",
        }),
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("maps raw streamed pre-tool assistant text to commentary from message delta", () =>
    Effect.gen(function* () {
      const sessionId = assistantPhaseSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkTextBlockStart({ sessionId }),
            sdkTextDelta({ sessionId, text: "I will verify with Bash." }),
            sdkContentBlockStop({ sessionId }),
            sdkMessageDelta({ sessionId, stopReason: "tool_use" }),
            sdkBashToolUseMessage({
              sessionId,
              command: "printf 'caara-smoke-cwd=%s\\n' \"$PWD\"",
            }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-message-0",
          text: "I will verify with Bash.",
          messagePhase: "commentary",
        }),
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-activity-0",
          text: "Using Bash: `printf 'caara-smoke-cwd=%s\\n' \"$PWD\"`",
          messagePhase: "commentary",
          transportVisibility: "visible",
        }),
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("maps orphan pre-tool assistant text deltas to commentary from message delta", () =>
    Effect.gen(function* () {
      const sessionId = assistantPhaseSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkTextDelta({ sessionId, text: "I will " }),
            sdkTextDelta({ sessionId, text: "verify with Bash." }),
            sdkMessageDelta({ sessionId, stopReason: "tool_use" }),
            sdkBashToolUseMessage({
              sessionId,
              command: "printf 'caara-smoke-cwd=%s\\n' \"$PWD\"",
            }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-message-0",
          text: "I will verify with Bash.",
          messagePhase: "commentary",
        }),
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-activity-0",
          text: "Using Bash: `printf 'caara-smoke-cwd=%s\\n' \"$PWD\"`",
          messagePhase: "commentary",
          transportVisibility: "visible",
        }),
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("defers phase-unknown completed assistant text until following tool use", () =>
    Effect.gen(function* () {
      const sessionId = assistantPhaseSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkAssistantTextMessage({
              sessionId,
              text: "I will verify with Bash.",
              stopReason: null,
            }),
            sdkBashToolUseMessage({
              sessionId,
              command: "printf 'caara-smoke-cwd=%s\\n' \"$PWD\"",
            }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-message-0",
          text: "I will verify with Bash.",
          messagePhase: "commentary",
        }),
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-activity-0",
          text: "Using Bash: `printf 'caara-smoke-cwd=%s\\n' \"$PWD\"`",
          messagePhase: "commentary",
          transportVisibility: "visible",
        }),
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("formats multiline Bash activity commands as shell code blocks", () =>
    Effect.gen(function* () {
      const sessionId = assistantPhaseSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkBashToolUseMessage({
              sessionId,
              command: "printf 'first line\\n'\npwd",
            }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-activity-0",
          text: "Using Bash:\n```bash\nprintf 'first line\\n'\npwd\n```",
          messagePhase: "commentary",
          transportVisibility: "visible",
        }),
        createRuntimeTurnSucceededEvent(),
      ] satisfies readonly AgentRuntimeEvent[]);
    }),
  );

  it.effect("flushes phase-unknown completed assistant text as final on success result", () =>
    Effect.gen(function* () {
      const sessionId = assistantPhaseSessionId();
      const harness = fakeSdkHarness({
        sessionIds: [sessionId],
        runtimeMessages: [
          [
            sdkAssistantTextMessage({
              sessionId,
              text: "The answer is ready.",
              stopReason: null,
            }),
            sdkSuccessResultMessage({ sessionId }),
          ],
        ],
      });
      const turn = makeTurn();

      const { events } = yield* runDriverTurn({ harness, turn });

      assert.deepStrictEqual(events, [
        ...createAssistantTextRuntimeEvents({
          itemId: "claude-sdk-message-0",
          text: "The answer is ready.",
          messagePhase: "final_answer",
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
      const request = harness.recordedRequests.at(0);
      assert.ok(request, "missing SDK query request");
      const promptMessages = yield* collectPromptMessages(request.prompt);

      assertRequestsUseNonInteractivePermissionPolicy(harness.recordedRequests);
      assert.deepStrictEqual(promptMessages, [
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "text", text: "follow-up request" }],
          },
        } satisfies SDKUserMessage,
      ]);
      assert.deepStrictEqual(
        harness.recordedRequests.map((recordedRequest) =>
          queryOptionsWithoutPermissionPolicy(recordedRequest.options),
        ),
        [
          {
            cwd: projectRoot,
            model: "opus",
            resume: "00000000-0000-4000-8000-000000000201",
            includePartialMessages: true,
            effort: "low",
          },
        ],
      );
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
      const request = harness.recordedRequests.at(0);
      assert.ok(request, "missing SDK query request");

      assertRequestsUseNonInteractivePermissionPolicy(harness.recordedRequests);
      assert.strictEqual(request.prompt, lostSessionRecoveryDriverPrompt);
      assert.deepStrictEqual(
        harness.recordedRequests.map((recordedRequest) =>
          queryOptionsWithoutPermissionPolicy(recordedRequest.options),
        ),
        [
          {
            cwd: "/new/project",
            model: "sonnet",
            sessionId: "00000000-0000-4000-8000-000000000302",
            includePartialMessages: true,
          },
        ],
      );
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

  it.effect("does not recover cwd-change turns with invalid driver options", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: ["00000000-0000-4000-8000-000000000303"],
        runtimeMessages: [],
      });
      const turn = makeTurn({
        target: makeTarget({ rawDriverOptions: { "permission-mode": "auto" } }),
        cwd: "/old/project",
        requestedCwd: "/new/project",
        externalSession: new DurableExternalSession({
          driverResumeCursor: makeDriverResumeCursor("00000000-0000-4000-8000-000000000303"),
        }),
      });

      const result = yield* Effect.result(runDriverTurn({ harness, turn }));

      Result.match(result, {
        onFailure: (error) => {
          assert.strictEqual(error.responseErrorCode, "invalid_prompt");
          assert.strictEqual(
            error.message,
            "Unsupported Claude Agent SDK driver option: permission-mode.",
          );
        },
        onSuccess: () => assert.fail("expected invalid driver option failure"),
      });
      assert.deepStrictEqual(harness.recordedRequests, []);
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
