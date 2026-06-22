import { Effect, Schema } from "effect";

import {
  buildClaudeCodePrintInvocation,
  type ClaudeCodePrintInvocationOptions,
} from "./invocation.ts";
import { summarizeClaudeCodeStream } from "./streamEvents.ts";
import type { ClaudeCodeStreamSummary } from "./streamTypes.ts";

/** Failure raised by the isolated manual contract harness runner. */
export class ClaudeCodeContractRunError extends Schema.TaggedErrorClass<ClaudeCodeContractRunError>()(
  "ClaudeCodeContractRunError",
  {
    message: Schema.String,
  },
) {}

/** Result returned by the isolated manual contract harness runner. */
export interface ClaudeCodeContractRunResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly lines: readonly string[];
  readonly summary: ClaudeCodeStreamSummary;
}

/** Converts an unknown harness failure into a typed run error. */
const runError = (cause: unknown): ClaudeCodeContractRunError =>
  new ClaudeCodeContractRunError({ message: String(cause) });

/** Runs the isolated Claude Code contract harness and summarizes stdout JSONL output. */
export const runClaudeCodeContractHarness = Effect.fnUntraced(function* (
  options: ClaudeCodePrintInvocationOptions,
) {
  const invocation = buildClaudeCodePrintInvocation(options);
  const childProcess = yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        Bun.spawn({
          cmd: [invocation.command, ...invocation.args],
          cwd: invocation.cwd,
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
    catch: runError,
  });
  const stdout = yield* Effect.tryPromise({
    try: () => new Response(childProcess.stdout).text(),
    catch: runError,
  });
  const stderr = yield* Effect.tryPromise({
    try: () => new Response(childProcess.stderr).text(),
    catch: runError,
  });
  const exitCode = yield* Effect.tryPromise({
    try: () => childProcess.exited,
    catch: runError,
  });
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summary = yield* summarizeClaudeCodeStream(lines);

  return {
    exitCode,
    stderr,
    lines,
    summary,
  } satisfies ClaudeCodeContractRunResult;
});
