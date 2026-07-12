import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";

import {
  PortableAgentCancelResult,
  PortableAgentStartResult,
  PortableAgentWaitResult,
} from "../caaraAgentContract.ts";

/** Explicit opt-in preventing normal tests from using Antigravity credentials or user services. */
const realAgySmokeEnabled = process.env.CAARA_REAL_AGY_SMOKE === "1";

/** Compiled client selected by the installed-service smoke environment. */
const caaraExecutable =
  process.env.CAARA_SMOKE_CAARA_EXECUTABLE ?? path.join(process.cwd(), "dist", "caara");

/** Stable marker used to prove continuity through a real resumed Antigravity conversation. */
const continuityNonce = (): string => "caara-portable-agy-continuity-907";

/** Completed result required by continuity assertions. */
interface CompletedPortableWait {
  readonly schemaVersion: 1;
  readonly status: "completed";
  readonly finalAnswer: string;
}

/** Executes one compiled CLI command and captures exit status plus both output streams. */
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

/** Starts one real Antigravity turn through the compiled CLI and already-installed service. */
const startRealAgy = Effect.fnUntraced(function* ({
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
    "agy/gemini-3.5-flash",
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

/** Performs one bounded long poll and requires a completed real Antigravity result. */
const waitForRealAgyAttempt = Effect.fnUntraced(function* (turnId: string) {
  const result = yield* runInstalledCaara([
    "agent",
    "wait",
    "--json",
    "--timeout-millis",
    "30000",
    turnId,
  ]);
  assert.ok(result.exitCode === 0 || result.exitCode === 11, result.stderr);
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentWaitResult))(
    result.stdout.trim(),
  );
  return yield* Effect.succeed(decoded).pipe(
    Effect.filterOrFail(
      (value): value is CompletedPortableWait => value.status === "completed",
      () => "real Antigravity turn remains working or ended without completion",
    ),
  );
});

/** Waits for a real turn using bounded 30-second long polls and a coherent 120-second ceiling. */
const waitForRealAgy = (turnId: string) =>
  waitForRealAgyAttempt(turnId).pipe(Effect.retry(Schedule.recurs(3)));

/** Reads one trusted human-viewer capability during the opt-in operator smoke. */
const readObservationViewer = Effect.fnUntraced(function* (observationUrl: string) {
  const response = yield* Effect.tryPromise(() => fetch(observationUrl));
  assert.strictEqual(response.status, 200);
  return yield* Effect.tryPromise(() => response.text());
});

/** Waits until the real Antigravity viewer proves non-empty normalized activity. */
const waitForViewerActivity = (observationUrl: string) =>
  readObservationViewer(observationUrl).pipe(
    Effect.filterOrFail((html) => /<h2>Activity<\/h2><pre>(?!<\/pre>)/u.test(html)),
    Effect.retry(Schedule.both(Schedule.spaced("250 millis"), Schedule.recurs(80))),
  );

describe.runIf(realAgySmokeEnabled)("installed Antigravity portable smoke", () => {
  it.live(
    "proves first turn, continuity, and cancellation through the installed service",
    () =>
      Effect.gen(function* () {
        const first = yield* startRealAgy({
          prompt: `Remember ${continuityNonce()}. Reply exactly: first-ok`,
        });
        const firstResult = yield* waitForRealAgy(first.turnId);
        assert.strictEqual(firstResult.status, "completed");
        assert.match(firstResult.finalAnswer, /first-ok/u);
        const firstViewer = yield* waitForViewerActivity(first.observationUrl);
        assert.match(firstViewer, /Status: completed/u);
        assert.strictEqual(
          /step_index|transcript_full\.jsonl|Created conversation/u.test(firstResult.finalAnswer),
          false,
        );

        const resumed = yield* startRealAgy({
          prompt: "Reply with only the nonce I asked you to remember.",
          sessionId: first.sessionId,
        });
        const resumedResult = yield* waitForRealAgy(resumed.turnId);
        assert.strictEqual(resumedResult.status, "completed");
        assert.match(resumedResult.finalAnswer, new RegExp(continuityNonce(), "u"));

        const cancellable = yield* startRealAgy({
          prompt:
            "Inspect every TypeScript source file and produce a detailed architecture review.",
        });
        yield* waitForViewerActivity(cancellable.observationUrl);
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
        assert.deepStrictEqual(cancelled, {
          schemaVersion: 1,
          status: "cancelled",
          outcome: "Terminated",
          sessionReusable: false,
        });
        const cancelledViewer = yield* readObservationViewer(cancellable.observationUrl);
        assert.match(cancelledViewer, /Status: cancelled/u);
        assert.match(cancelledViewer, /Session reusable: false/u);
      }),
    300_000,
  );
});
