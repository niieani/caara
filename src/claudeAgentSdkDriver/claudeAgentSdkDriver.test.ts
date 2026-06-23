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
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
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
  sdkTextDelta,
  sdkThinkingDelta,
} from "./claudeAgentSdkDriverTestHarness.ts";
import {
  assertRequestsUseNonInteractivePermissionPolicy,
  queryOptionsWithoutPermissionPolicy,
} from "./claudeAgentSdkTestAssertions.ts";

/** Stable cwd used by SDK driver tests. */
const projectRoot = process.cwd();

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

/** Builds one direct driver turn with core-normalized current-user prompt input. */
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
