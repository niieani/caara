import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryAssistantText } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import {
  getField,
  makePolicyHarness,
  policyTestError,
  readArgvLog,
  readPersistedBinding,
  readTextFile,
  runCompletedTurn,
  runDisconnectedTurn,
  runErrorTurn,
} from "./claudeCodeDriverPolicyHarness.ts";

describe("Claude Code driver policies", () => {
  it.effect("cancels a disconnected Claude process and resumes the reusable session", () =>
    Effect.gen(function* () {
      const harness = yield* makePolicyHarness({ heldTurnId: "turn-cancel-held" });

      yield* runDisconnectedTurn({
        harness,
        threadId: "thread-claude-cancel",
        turnId: "turn-cancel-held",
        prompt: "hold for cancellation",
      });
      const resumedText = yield* runCompletedTurn({
        harness,
        threadId: "thread-claude-cancel",
        turnId: "turn-after-cancel",
        prompt: "after cancel",
        includeWorkspace: false,
        includeCwd: false,
      });
      const argvLog = yield* readArgvLog({ filePath: harness.argvFile });
      const firstSessionId = argvLog.at(0)?.at((argvLog.at(0)?.indexOf("--session-id") ?? -1) + 1);
      const secondArgv = argvLog.at(1);

      assert.ok(firstSessionId, "first fake Claude invocation must receive --session-id");
      assert.ok(secondArgv, "follow-up fake Claude invocation must be recorded");
      assert.strictEqual(resumedText, "FAKE_AFTER_RESUME");
      assert.deepStrictEqual(secondArgv.slice(4, 6), ["--resume", firstSessionId]);
      assert.match(yield* readTextFile({ filePath: harness.signalFile }), /SIGINT/);
      assert.deepStrictEqual(
        harness.relayEvents.filter((event) => event._tag === "TurnCancelled"),
        [
          {
            _tag: "TurnCancelled",
            externalAgentKind: "claude",
            codexThreadId: "thread-claude-cancel",
            turnId: "turn-cancel-held",
            outcomeTag: "Interrupted",
            sessionReusable: true,
          },
        ],
      );
    }),
  );

  it.effect("recovers an unresumable Claude session with a fresh binding and recovery reply", () =>
    Effect.gen(function* () {
      const harness = yield* makePolicyHarness({
        heldTurnId: "unused",
        extraEnv: { CAARA_FAKE_CLAUDE_RESUME_FAIL: "1" },
      });

      yield* runCompletedTurn({
        harness,
        threadId: "thread-claude-recovery",
        turnId: "turn-recovery-seed",
        prompt: "seed",
        includeWorkspace: true,
        includeCwd: true,
      });
      const recoveryText = yield* runCompletedTurn({
        harness,
        threadId: "thread-claude-recovery",
        turnId: "turn-recovery-fresh",
        prompt: "resume should recover",
        includeWorkspace: false,
        includeCwd: false,
      });
      const argvLog = yield* readArgvLog({ filePath: harness.argvFile });
      const freshSessionId = argvLog.at(2)?.at((argvLog.at(2)?.indexOf("--session-id") ?? -1) + 1);
      const binding = yield* readPersistedBinding({
        stateDir: harness.stateDir,
        threadId: "thread-claude-recovery",
      });
      const durableSession = yield* Schema.decodeUnknownEffect(DurableExternalSession)(
        binding.externalSession,
      ).pipe(Effect.mapError((cause) => policyTestError(cause)));

      assert.strictEqual(recoveryText, lostSessionRecoveryAssistantText);
      assert.ok(freshSessionId, "recovery fake Claude invocation must receive fresh --session-id");
      assert.deepStrictEqual(argvLog.at(1)?.slice(4, 5), ["--resume"]);
      assert.strictEqual(durableSession.driverResumeCursor, freshSessionId);
      assert.strictEqual(binding.createdFromTurnId, "turn-recovery-seed");
      assert.strictEqual(binding.lastTurnId, "turn-recovery-fresh");
    }),
  );

  it.effect("preserves the old binding when Claude resume and fresh start both fail", () =>
    Effect.gen(function* () {
      const harness = yield* makePolicyHarness({
        heldTurnId: "unused",
        extraEnv: {
          CAARA_FAKE_CLAUDE_RESUME_FAIL: "1",
          CAARA_FAKE_CLAUDE_FRESH_FAIL: "1",
        },
      });
      yield* runCompletedTurn({
        harness,
        threadId: "thread-claude-unrecoverable",
        turnId: "turn-unrecoverable-seed",
        prompt: "seed",
        includeWorkspace: true,
        includeCwd: true,
      });
      const originalBinding = yield* readPersistedBinding({
        stateDir: harness.stateDir,
        threadId: "thread-claude-unrecoverable",
      });

      const failure = yield* runErrorTurn({
        harness,
        threadId: "thread-claude-unrecoverable",
        turnId: "turn-unrecoverable-failed",
        prompt: "resume should fail",
      });
      assert.strictEqual(failure.status, 500);
      assert.strictEqual(getField(getField(failure.body, "error"), "type"), "server_error");
      assert.match(
        String(getField(getField(failure.body, "error"), "message")),
        /fresh external session/i,
      );
      assert.deepStrictEqual(
        yield* readPersistedBinding({
          stateDir: harness.stateDir,
          threadId: "thread-claude-unrecoverable",
        }),
        originalBinding,
      );
    }),
  );
});
