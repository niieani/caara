import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Schedule, Schema } from "effect";

import {
  PortableAgentCancelResult,
  PortableAgentStartResult,
  PortableAgentWaitResult,
} from "../caaraAgentContract.ts";

/** Explicit opt-in preventing normal test runs from using credentials, network, or user services. */
const realClaudeSmokeEnabled = process.env.CAARA_REAL_CLAUDE_SMOKE === "1";

/** Compiled installed-service client selected by the opt-in smoke environment. */
const caaraExecutable =
  process.env.CAARA_SMOKE_CAARA_EXECUTABLE ?? path.join(process.cwd(), "dist", "caara");

/** Stable continuity marker expected back from the resumed real Claude session. */
const continuityNonce = (): string => "caara-portable-continuity-801";

/** Executes one compiled Caara CLI command and captures its complete process contract. */
const runInstalledCaara = Effect.fnUntraced(function* (args: readonly string[]) {
  const child = Bun.spawn([caaraExecutable, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]),
  );
  return { exitCode, stdout, stderr };
});

/** Starts one real Claude turn through the compiled CLI and installed user service. */
const startRealClaude = Effect.fnUntraced(function* ({
  prompt,
  sessionId,
}: {
  readonly prompt: string;
  readonly sessionId?: string;
}) {
  const sessionArgs = ["--session-id", sessionId ?? ""].filter(() => sessionId !== undefined);
  const result = yield* runInstalledCaara([
    "agent",
    "start",
    "--json",
    "--target",
    "claude/sonnet",
    "--cwd",
    process.cwd(),
    "--option",
    "effort=low",
    ...sessionArgs,
    "--prompt",
    prompt,
  ]);
  assert.strictEqual(result.exitCode, 10, result.stderr);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentStartResult))(
    result.stdout.trim(),
  );
});

/** Repeats bounded waits until the real installed turn reaches a terminal result. */
const waitForRealClaude = Effect.fnUntraced(function* (turnId: string) {
  const result = yield* runInstalledCaara([
    "agent",
    "wait",
    "--json",
    "--timeout-millis",
    "30000",
    turnId,
  ]);
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentWaitResult))(
    result.stdout.trim(),
  );
  return yield* Match.value(decoded).pipe(
    Match.when({ status: "working" }, () => Effect.fail("real Claude turn remains working")),
    Match.when({ status: "completed" }, (completed) => Effect.succeed(completed)),
    Match.orElse(({ status }) => Effect.fail(`real Claude turn ended with ${status}`)),
  );
});

describe.runIf(realClaudeSmokeEnabled)("installed Claude portable smoke", () => {
  it.live(
    "proves first turn, continuity, and cancellation through the installed service",
    () =>
      Effect.gen(function* () {
        const first = yield* startRealClaude({
          prompt: `Remember ${continuityNonce()}. Reply exactly: first-ok`,
        });
        const firstResult = yield* waitForRealClaude(first.turnId).pipe(
          Effect.retry(Schedule.recurs(3)),
        );
        assert.match(firstResult.finalAnswer, /first-ok/u);

        const resumed = yield* startRealClaude({
          prompt: "Reply with only the nonce I asked you to remember.",
          sessionId: first.sessionId,
        });
        const resumedResult = yield* waitForRealClaude(resumed.turnId).pipe(
          Effect.retry(Schedule.recurs(3)),
        );
        assert.match(resumedResult.finalAnswer, new RegExp(continuityNonce(), "u"));

        const cancellable = yield* startRealClaude({
          prompt:
            "Inspect every TypeScript source file and produce a detailed architecture review.",
        });
        const cancelledProcess = yield* runInstalledCaara([
          "agent",
          "cancel",
          "--json",
          cancellable.turnId,
        ]);
        assert.strictEqual(cancelledProcess.exitCode, 12, cancelledProcess.stderr);
        const cancelled = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(PortableAgentCancelResult),
        )(cancelledProcess.stdout.trim());
        assert.strictEqual(cancelled.status, "cancelled");
      }),
    300_000,
  );
});
