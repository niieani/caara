import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result, Stream } from "effect";

import { createRuntimeTurnSucceededEvent } from "../mockResponsesProvider/agentDriver.ts";
import type { ClaudeAgentSdkQueryRuntime } from "./claudeAgentSdkClient.ts";
import { runtimeEventsFromClaudeAgentSdkQuery } from "./events.ts";
import { buildClaudeAgentSdkQueryOptions } from "./options.ts";

/** Stable cwd used by SDK permission policy tests. */
const projectRoot = process.cwd();

/** Builds one fake SDK permission-denied system message. */
const sdkPermissionDeniedMessage = (): SDKMessage =>
  ({
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "toolu_permission_denied",
    decision_reason_type: "mode",
    decision_reason: "dontAsk denied unapproved tool",
    message: "Caara denied this permission request.",
    session_id: "00000000-0000-4000-8000-00000000p001",
    uuid: "00000000-0000-4000-8000-00000000p002",
  }) satisfies SDKMessage;

/** Builds a fake SDK query runtime that emits fixed messages. */
const fakeRuntime = (messages: readonly SDKMessage[]): ClaudeAgentSdkQueryRuntime => ({
  interrupt: () => Promise.resolve(),
  close: () => {},
  setModel: () => Promise.resolve(),
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

/** Extracts the driver error from an expected SDK option failure result. */
const driverErrorMessage = (result: Result.Result<unknown, { readonly message: string }>): string =>
  Result.match(result, {
    onFailure: (error) => error.message,
    onSuccess: () => assert.fail("expected SDK option validation failure"),
  });

describe("Claude Agent SDK permission policy", () => {
  it.effect("builds non-interactive permission options that deny prompts explicitly", () =>
    Effect.gen(function* () {
      const options = yield* buildClaudeAgentSdkQueryOptions({
        cwd: projectRoot,
        model: "sonnet",
        rawDriverOptions: {},
        startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p101" },
      });
      assert.ok(options.canUseTool, "SDK options must install canUseTool");
      assert.ok(options.onUserDialog, "SDK options must install onUserDialog");

      const controller = new AbortController();
      const permission = yield* Effect.promise(
        () =>
          options.canUseTool?.(
            "Bash",
            { command: "rm -rf ." },
            {
              signal: controller.signal,
              toolUseID: "toolu_request",
            },
          ) ?? Promise.reject(new Error("missing canUseTool")),
      );
      const dialog = yield* Effect.promise(
        () =>
          options.onUserDialog?.(
            { dialogKind: "refusal_fallback_prompt", payload: {}, toolUseID: "toolu_dialog" },
            { signal: controller.signal },
          ) ?? Promise.reject(new Error("missing onUserDialog")),
      );

      assert.strictEqual(options.permissionMode, "dontAsk");
      assert.deepStrictEqual(options.disallowedTools, ["AskUserQuestion"]);
      assert.deepStrictEqual(options.supportedDialogKinds, []);
      assert.deepStrictEqual(permission, {
        behavior: "deny",
        message: "Caara subagents cannot approve interactive tool permissions during a Codex turn.",
        toolUseID: "toolu_request",
        decisionClassification: "user_reject",
      });
      assert.deepStrictEqual(dialog, { behavior: "cancelled" });
    }),
  );

  it.effect("accepts noninteractive permission modes from query options", () =>
    Effect.gen(function* () {
      const autoOptions = yield* buildClaudeAgentSdkQueryOptions({
        cwd: projectRoot,
        model: "sonnet",
        rawDriverOptions: { permission_mode: "auto" },
        startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p111" },
      });
      const dontAskOptions = yield* buildClaudeAgentSdkQueryOptions({
        cwd: projectRoot,
        model: "sonnet",
        rawDriverOptions: { permission_mode: "dontAsk" },
        startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p112" },
      });
      const bypassOptions = yield* buildClaudeAgentSdkQueryOptions({
        cwd: projectRoot,
        model: "sonnet",
        rawDriverOptions: { permission_mode: "bypassPermissions" },
        startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p113" },
      });
      const hyphenAliasOptions = yield* buildClaudeAgentSdkQueryOptions({
        cwd: projectRoot,
        model: "sonnet",
        rawDriverOptions: { "permission-mode": "auto" },
        startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p114" },
      });

      assert.strictEqual(autoOptions.permissionMode, "auto");
      assert.strictEqual(dontAskOptions.permissionMode, "dontAsk");
      assert.strictEqual(bypassOptions.permissionMode, "bypassPermissions");
      assert.strictEqual(bypassOptions.allowDangerouslySkipPermissions, true);
      assert.strictEqual(hyphenAliasOptions.permissionMode, "auto");
    }),
  );

  it.effect("rejects interactive or ambiguous permission mode query options", () =>
    Effect.gen(function* () {
      const defaultResult = yield* Effect.result(
        buildClaudeAgentSdkQueryOptions({
          cwd: projectRoot,
          model: "sonnet",
          rawDriverOptions: { permission_mode: "default" },
          startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p115" },
        }),
      );
      const planResult = yield* Effect.result(
        buildClaudeAgentSdkQueryOptions({
          cwd: projectRoot,
          model: "sonnet",
          rawDriverOptions: { permission_mode: "plan" },
          startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p116" },
        }),
      );
      const duplicateAliasResult = yield* Effect.result(
        buildClaudeAgentSdkQueryOptions({
          cwd: projectRoot,
          model: "sonnet",
          rawDriverOptions: { permission_mode: "auto", "permission-mode": "dontAsk" },
          startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p117" },
        }),
      );

      assert.match(
        driverErrorMessage(defaultResult),
        /permission_mode.*auto.*dontAsk.*bypassPermissions/u,
      );
      assert.match(
        driverErrorMessage(planResult),
        /permission_mode.*auto.*dontAsk.*bypassPermissions/u,
      );
      assert.match(driverErrorMessage(duplicateAliasResult), /permission mode.*duplicate/i);
    }),
  );

  it.effect("rejects option attempts that would allow AskUserQuestion", () =>
    Effect.gen(function* () {
      const allowedToolsResult = yield* Effect.result(
        buildClaudeAgentSdkQueryOptions({
          cwd: projectRoot,
          model: "sonnet",
          rawDriverOptions: { allowed_tools: "AskUserQuestion" },
          startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p102" },
        }),
      );
      const toolsResult = yield* Effect.result(
        buildClaudeAgentSdkQueryOptions({
          cwd: projectRoot,
          model: "sonnet",
          rawDriverOptions: { tools: "Read,AskUserQuestion" },
          startup: { _tag: "Start", sessionId: "00000000-0000-4000-8000-00000000p103" },
        }),
      );

      assert.match(driverErrorMessage(allowedToolsResult), /AskUserQuestion.*reserved/i);
      assert.match(driverErrorMessage(toolsResult), /AskUserQuestion.*reserved/i);
    }),
  );

  it.effect("maps SDK permission-denied messages to explicit runtime events", () =>
    Effect.gen(function* () {
      const events = yield* runtimeEventsFromClaudeAgentSdkQuery({
        runtime: fakeRuntime([sdkPermissionDeniedMessage()]),
      }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => [...chunk]),
      );

      assert.deepStrictEqual(events, [
        {
          _tag: "PermissionDenied",
          toolName: "Bash",
          toolUseId: "toolu_permission_denied",
          message: "Caara denied this permission request.",
          decisionReason: "dontAsk denied unapproved tool",
        },
        createRuntimeTurnSucceededEvent(),
      ]);
    }),
  );
});
