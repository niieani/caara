import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Logger } from "effect";

/** CPU-time budget for a scoped idle logger over the real-time observation window. */
const idleLoggerCpuBudgetMicros = 100_000;

/** Real-time observation window long enough to expose a tight zero-delay logger loop. */
const idleLoggerObservationWindow = Duration.millis(250);

/** Returns total user plus system CPU microseconds since the supplied snapshot. */
const elapsedCpuMicros = (snapshot: ReturnType<typeof process.cpuUsage>): number => {
  const elapsed = process.cpuUsage(snapshot);
  return elapsed.user + elapsed.system;
};

/** Allocates a test-local log file path for a logger CPU contract check. */
const loggerCpuTestFile = Effect.fnUntraced(function* () {
  const directory = path.join(process.cwd(), "temp.local", "effect-logger-patch");
  yield* Effect.tryPromise(() => fs.mkdir(directory, { recursive: true }));
  return path.join(directory, `${randomUUID()}.jsonl`);
});

/** Opens a zero-window Effect file logger and leaves it idle for one observation window. */
const observeIdleZeroWindowFileLogger = Effect.fnUntraced(function* ({
  logFile,
}: {
  readonly logFile: string;
}) {
  yield* Logger.formatJson.pipe(Logger.toFile(logFile, { batchWindow: "0 millis" }));
  yield* Effect.sleep(idleLoggerObservationWindow);
});

describe("patched Effect file logger", () => {
  it.live("does not busy-loop when a zero batch window is requested", () =>
    Effect.gen(function* () {
      const logFile = yield* loggerCpuTestFile();
      const before = process.cpuUsage();

      yield* Effect.scoped(observeIdleZeroWindowFileLogger({ logFile })).pipe(
        Effect.provide(BunServices.layer),
      );

      assert.ok(
        elapsedCpuMicros(before) < idleLoggerCpuBudgetMicros,
        "zero-window file logger must not consume a full CPU while idle",
      );
    }),
  );
});
