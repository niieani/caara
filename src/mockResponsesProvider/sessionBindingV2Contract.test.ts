import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Result } from "effect";

import { type AgentDriverTurn, AgentDriverError } from "./agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "./codexTurnContext.ts";
import { InvalidResponsesRequest } from "./errors.ts";
import {
  CaaraSessionBinding,
  DurableExternalSession,
  makeApiResponseId,
  makeCodexParentSessionId,
  makeCodexThreadId,
  makeCodexTurnId,
  makeDriverInstanceId,
  makeDriverResumeCursor,
  makeExternalAgentKind,
  makeExternalModelSpecifier,
  makeRequestedModelSpecifier,
  prepareSessionBinding,
  SessionDirectory,
} from "./sessionDirectory.ts";
import { simulatorAgentDriver } from "./simulatorDriver.ts";

/** Codex context without cwd sources, representing a follow-up-only request. */
const followUpCodex = new CodexTurnContext({
  parentSessionId: "parent-session-v2",
  threadId: "codex-thread-v2",
  turnId: "turn-v2",
  parentThreadId: "parent-thread-v2",
  windowId: "window-v2",
  requestKind: "turn",
  subagentKind: "caara",
  originator: "codex_cli_rs",
  requestedModel: "claude/test",
  workspacePaths: [],
  cwdCandidates: [],
});

/** Target used for v2 binding lookup contract tests. */
const claudeTarget = new AgentTarget({
  requestedModel: "claude/test",
  externalAgentKind: "claude",
  externalModelSpecifier: "test",
  rawDriverOptions: {},
});

/** Builds a stored binding fixture with configurable key and cursor details. */
const storedBinding = ({
  externalAgentKind = "claude",
  driverResumeCursor = '{"sessionId":"simulator-session"}',
}: {
  readonly externalAgentKind?: string;
  readonly driverResumeCursor?: string;
} = {}) =>
  new CaaraSessionBinding({
    schemaVersion: 2,
    apiResponseId: makeApiResponseId("resp_turn-v2"),
    bindingKey: {
      externalAgentKind: makeExternalAgentKind(externalAgentKind),
      driverInstanceId: makeDriverInstanceId(externalAgentKind),
      codexThreadId: makeCodexThreadId(followUpCodex.threadId),
    },
    parentCodexSessionId: makeCodexParentSessionId(followUpCodex.parentSessionId),
    requestedTarget: {
      requestedModel: makeRequestedModelSpecifier("claude/test"),
      externalModelSpecifier: makeExternalModelSpecifier("test"),
      rawDriverOptions: {},
    },
    externalSession: new DurableExternalSession({
      driverResumeCursor: makeDriverResumeCursor(driverResumeCursor),
    }),
    cwd: process.cwd(),
    createdFromTurnId: makeCodexTurnId("turn-v2-created"),
    lastTurnId: makeCodexTurnId("turn-v2-last"),
  });

/** Builds a session directory layer returning one optional stored binding. */
const sessionDirectoryLayer = (binding: Option.Option<CaaraSessionBinding>) =>
  Layer.succeed(SessionDirectory, {
    get: () => Effect.succeed(binding),
    save: () => Effect.void,
    delete: () => Effect.void,
  });

/** Extracts an InvalidResponsesRequest message from an expected failure. */
const invalidRequestMessage = (result: Result.Result<unknown, unknown>): string => {
  const error = Result.match(result, {
    onFailure: (failure) => failure,
    onSuccess: () => assert.fail("expected InvalidResponsesRequest failure"),
  });
  assert.ok(error instanceof InvalidResponsesRequest);
  return error.message;
};

/** Builds a simulator driver turn from a prepared v2 binding. */
const simulatorTurn = (binding: CaaraSessionBinding): AgentDriverTurn => ({
  codex: followUpCodex,
  target: claudeTarget,
  prompt: { input: [] },
  cwd: binding.cwd,
  previousTarget: claudeTarget,
  externalSession: binding.externalSession,
});

describe("session binding v2 contracts", () => {
  it.effect("fails follow-up lookup when the required binding is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        prepareSessionBinding({ codex: followUpCodex, target: claudeTarget }).pipe(
          Effect.provide(sessionDirectoryLayer(Option.none())),
        ),
      );

      assert.match(invalidRequestMessage(result), /session binding/i);
    }),
  );

  it.effect("fails follow-up lookup when the stored binding belongs to another driver", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        prepareSessionBinding({ codex: followUpCodex, target: claudeTarget }).pipe(
          Effect.provide(
            sessionDirectoryLayer(Option.some(storedBinding({ externalAgentKind: "gemini" }))),
          ),
        ),
      );

      assert.match(invalidRequestMessage(result), /external agent kind/i);
    }),
  );

  it.effect("fails the driver turn when the driver-owned resume cursor is invalid", () =>
    Effect.gen(function* () {
      const binding = storedBinding({ driverResumeCursor: "not-json" });
      const result = yield* Effect.result(
        simulatorAgentDriver.startOrResumeTurn(simulatorTurn(binding)),
      );
      const failure = Result.match(result, {
        onFailure: (error) => error,
        onSuccess: () => assert.fail("expected AgentDriverError failure"),
      });

      assert.ok(failure instanceof AgentDriverError);
      assert.match(failure.message, /resume cursor/i);
    }),
  );
});
