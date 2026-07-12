import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  CaaraAgentExitCode,
  PortableAgentStartResult,
  PortableAgentWaitResult,
  agentExitCode,
  renderAgentResult,
} from "./caaraAgentContract.ts";
import { PortableSessionId, PortableTurnId } from "./portableAgentIdentity.ts";

describe("portable Agent public contract", () => {
  it.effect("requires the versioned stable JSON envelope", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(PortableAgentStartResult)({
        schemaVersion: 1,
        turnId: PortableTurnId.make("portable-turn-00000000-0000-4000-8000-000000000001"),
        sessionId: PortableSessionId.make("portable-session-1"),
        status: "accepted",
        observationUrl: "http://127.0.0.1/observe/capability",
      });
      assert.strictEqual(result.schemaVersion, 1);
      assert.isTrue(
        (yield* Effect.result(
          Schema.decodeUnknownEffect(PortableAgentStartResult)({ ...result, schemaVersion: 2 }),
        )).pipe((exit) => exit._tag === "Failure"),
      );
    }),
  );

  it("maps every documented outcome to a stable process exit code", () => {
    assert.strictEqual(
      agentExitCode({
        schemaVersion: 1,
        status: "working",
        turnId: PortableTurnId.make("portable-turn-00000000-0000-4000-8000-000000000001"),
        sessionId: PortableSessionId.make("portable-session-1"),
        observationUrl: "http://127.0.0.1/observe/capability",
      }),
      CaaraAgentExitCode.Working,
    );
    assert.strictEqual(
      agentExitCode({ schemaVersion: 1, status: "completed", finalAnswer: "done" }),
      CaaraAgentExitCode.Completed,
    );
    assert.strictEqual(
      agentExitCode({ schemaVersion: 1, status: "failed" }),
      CaaraAgentExitCode.Failed,
    );
    assert.strictEqual(
      agentExitCode({
        schemaVersion: 1,
        status: "cancelled",
        outcome: "Interrupted",
        sessionReusable: true,
      }),
      CaaraAgentExitCode.Cancelled,
    );
    for (const [kind, expected] of [
      ["invalid_request", CaaraAgentExitCode.InvalidRequest],
      ["service_unavailable", CaaraAgentExitCode.ServiceUnavailable],
      ["unknown_resource", CaaraAgentExitCode.UnknownResource],
      ["target_failure", CaaraAgentExitCode.TargetFailure],
      ["concurrency_conflict", CaaraAgentExitCode.ConcurrencyConflict],
    ] as const) {
      assert.strictEqual(
        agentExitCode({ schemaVersion: 1, status: "error", error: { kind, message: kind } }),
        expected,
      );
    }
  });

  it.effect("derives concise human output from the same typed result", () =>
    Effect.gen(function* () {
      const completed = yield* Schema.decodeUnknownEffect(PortableAgentWaitResult)({
        schemaVersion: 1,
        status: "completed",
        finalAnswer: "line one\nλ line two",
      });
      assert.strictEqual(renderAgentResult(completed), "Completed\nline one\nλ line two");
      assert.strictEqual(
        renderAgentResult({
          schemaVersion: 1,
          status: "error",
          error: { kind: "invalid_request", message: "Invalid working directory." },
        }),
        "Error: Invalid working directory.",
      );
    }),
  );
});
