import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import { buildClaudeCodePrintInvocation } from "./invocation.ts";
import {
  inferClaudeCodeCancellationReuse,
  parseClaudeCodeStreamLine,
  summarizeClaudeCodeStream,
} from "./streamEvents.ts";
import type { ClaudeCodeContractParseError } from "./streamTypes.ts";

/** Fixture cwd used by command-building and stream-summary tests. */
const fixture = {
  cwd: "/work/caara",
} as const;

/** Encodes one stream fixture line through the same schema boundary used by source tests. */
const encodeStreamLine = Schema.encodeSync(Schema.UnknownFromJsonString);

/** Successful Haiku stream captured from `claude -p --verbose --output-format stream-json`. */
const successfulHaikuStream = [
  encodeStreamLine({
    type: "system",
    subtype: "init",
    cwd: fixture.cwd,
    session_id: "2dd22e9d-e2fd-466d-81b8-43745958ee3d",
    tools: [],
    model: "claude-haiku-4-5-20251001",
    permissionMode: "default",
    claude_code_version: "2.1.185",
  }),
  encodeStreamLine({
    type: "assistant",
    message: {
      content: [
        {
          type: "thinking",
          thinking: "Brief hidden reasoning.",
        },
      ],
    },
    session_id: "2dd22e9d-e2fd-466d-81b8-43745958ee3d",
  }),
  encodeStreamLine({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "CAARA_HAIKU_OK",
        },
      ],
    },
    session_id: "2dd22e9d-e2fd-466d-81b8-43745958ee3d",
  }),
  encodeStreamLine({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "CAARA_HAIKU_OK",
    stop_reason: "end_turn",
    session_id: "2dd22e9d-e2fd-466d-81b8-43745958ee3d",
    terminal_reason: "completed",
  }),
];

/** Unavailable model stream proving CLI-accepted models can still fail inside the event stream. */
const unavailableFableStream = [
  encodeStreamLine({
    type: "system",
    subtype: "init",
    cwd: fixture.cwd,
    session_id: "2748e6be-2b1f-4c03-b069-d6d0c5783a0b",
    tools: [],
    model: "claude-fable-5",
    permissionMode: "default",
    claude_code_version: "2.1.185",
  }),
  encodeStreamLine({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "Claude Fable 5 is currently unavailable.",
        },
      ],
    },
    session_id: "2748e6be-2b1f-4c03-b069-d6d0c5783a0b",
  }),
  encodeStreamLine({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Claude Fable 5 is currently unavailable.",
    stop_reason: null,
    session_id: "2748e6be-2b1f-4c03-b069-d6d0c5783a0b",
    terminal_reason: "completed",
  }),
];

/** Interrupted stream captured after SIGINT with `--include-partial-messages`. */
const interruptedStream = [
  encodeStreamLine({
    type: "system",
    subtype: "init",
    cwd: fixture.cwd,
    session_id: "36fd88da-9f0b-4a99-8027-186478e04b0d",
    tools: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    claude_code_version: "2.1.185",
  }),
  encodeStreamLine({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: {
        type: "text_delta",
        text: "CAARA_CANCEL_STREAM",
      },
    },
    session_id: "36fd88da-9f0b-4a99-8027-186478e04b0d",
  }),
  encodeStreamLine({
    type: "user",
    message: {
      content: [
        {
          type: "text",
          text: "[Request interrupted by user]",
        },
      ],
    },
    session_id: "36fd88da-9f0b-4a99-8027-186478e04b0d",
  }),
  encodeStreamLine({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    session_id: "36fd88da-9f0b-4a99-8027-186478e04b0d",
    terminal_reason: "aborted_streaming",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
  }),
];

/** Resume probe stream proving a SIGINT-interrupted Claude session can be reused from same cwd. */
const resumedAfterInterruptStream = [
  encodeStreamLine({
    type: "system",
    subtype: "init",
    cwd: fixture.cwd,
    session_id: "36fd88da-9f0b-4a99-8027-186478e04b0d",
    tools: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    claude_code_version: "2.1.185",
  }),
  encodeStreamLine({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "CAARA_AFTER_CANCEL_OK",
        },
      ],
    },
    session_id: "36fd88da-9f0b-4a99-8027-186478e04b0d",
  }),
  encodeStreamLine({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "CAARA_AFTER_CANCEL_OK",
    stop_reason: "end_turn",
    session_id: "36fd88da-9f0b-4a99-8027-186478e04b0d",
    terminal_reason: "completed",
  }),
];

/** Extracts a parser error from an expected failure result. */
const parseErrorFromResult = (
  result: Result.Result<unknown, ClaudeCodeContractParseError>,
): ClaudeCodeContractParseError =>
  Result.match(result, {
    onFailure: (error) => error,
    onSuccess: () => assert.fail("parse unexpectedly succeeded"),
  });

describe("Claude Code contract harness", () => {
  it("builds a print-mode stream-json invocation in the chosen cwd", () => {
    const invocation = buildClaudeCodePrintInvocation({
      cwd: fixture.cwd,
      prompt: "Reply with exactly CAARA_HAIKU_OK and nothing else.",
      model: "haiku",
      effort: "low",
      maxBudgetUsd: "0.02",
      tools: "disabled",
      debugFile: "../debug.log",
    });

    assert.strictEqual(invocation.command, "claude");
    assert.strictEqual(invocation.cwd, fixture.cwd);
    assert.deepStrictEqual(invocation.args, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--max-budget-usd",
      "0.02",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--disallowed-tools",
      "AskUserQuestion",
      "--debug-file",
      "../debug.log",
      "Reply with exactly CAARA_HAIKU_OK and nothing else.",
    ]);
  });

  it("builds non-interactive permission flags into print-mode invocations by default", () => {
    const invocation = buildClaudeCodePrintInvocation({
      cwd: fixture.cwd,
      prompt: "Reply with exactly CAARA_PERMISSION_OK and nothing else.",
      model: "sonnet",
    });

    assert.deepStrictEqual(invocation.args, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      "sonnet",
      "--permission-mode",
      "dontAsk",
      "--disallowed-tools",
      "AskUserQuestion",
      "Reply with exactly CAARA_PERMISSION_OK and nothing else.",
    ]);
  });

  it("builds a same-cwd resume probe with partial streaming enabled", () => {
    const invocation = buildClaudeCodePrintInvocation({
      cwd: fixture.cwd,
      prompt: "Reply with exactly CAARA_AFTER_CANCEL_OK and nothing else.",
      model: "sonnet",
      effort: "low",
      tools: "disabled",
      resumeSessionId: "36fd88da-9f0b-4a99-8027-186478e04b0d",
      includePartialMessages: true,
    });

    assert.deepStrictEqual(invocation.args, [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--resume",
      "36fd88da-9f0b-4a99-8027-186478e04b0d",
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--disallowed-tools",
      "AskUserQuestion",
      "Reply with exactly CAARA_AFTER_CANCEL_OK and nothing else.",
    ]);
  });

  it.effect("summarizes assistant text, session id, cwd, model, and result", () =>
    Effect.gen(function* () {
      const summary = yield* summarizeClaudeCodeStream(successfulHaikuStream);

      assert.strictEqual(summary.cwd, fixture.cwd);
      assert.strictEqual(summary.sessionId, "2dd22e9d-e2fd-466d-81b8-43745958ee3d");
      assert.strictEqual(summary.model, "claude-haiku-4-5-20251001");
      assert.deepStrictEqual(summary.tools, []);
      assert.strictEqual(summary.assistantText, "CAARA_HAIKU_OK");
      assert.strictEqual(summary.result?.isError, false);
      assert.strictEqual(summary.result?.resultText, "CAARA_HAIKU_OK");
      assert.strictEqual(summary.result?.terminalReason, "completed");
    }),
  );

  it.effect("keeps CLI-accepted model failures visible as stream results", () =>
    Effect.gen(function* () {
      const summary = yield* summarizeClaudeCodeStream(unavailableFableStream);

      assert.strictEqual(summary.model, "claude-fable-5");
      assert.strictEqual(summary.result?.subtype, "success");
      assert.strictEqual(summary.result?.isError, true);
      assert.match(summary.assistantText, /currently unavailable/);
    }),
  );

  it.effect("infers same-cwd SIGINT cancellation leaves the Claude session reusable", () =>
    Effect.gen(function* () {
      const interruptedSummary = yield* summarizeClaudeCodeStream(interruptedStream);
      const resumedSummary = yield* summarizeClaudeCodeStream(resumedAfterInterruptStream);
      const reuse = inferClaudeCodeCancellationReuse({
        interruptedSummary,
        resumedSummary,
      });

      assert.deepStrictEqual(interruptedSummary.textDeltas, ["CAARA_CANCEL_STREAM"]);
      assert.strictEqual(interruptedSummary.result?.terminalReason, "aborted_streaming");
      assert.deepStrictEqual(reuse, {
        _tag: "ReusableAfterInterrupt",
        sessionId: "36fd88da-9f0b-4a99-8027-186478e04b0d",
      });
    }),
  );

  it.effect("fails explicitly on malformed stream-json lines", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(parseClaudeCodeStreamLine("{malformed"));
      const error = parseErrorFromResult(result);

      assert.strictEqual(error._tag, "ClaudeCodeContractParseError");
      assert.match(error.message, /json/i);
    }),
  );
});
