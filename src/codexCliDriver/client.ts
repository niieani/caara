import { Effect, Match, Option, Schema, Stream } from "effect";

import {
  type AgentCancellationOutcome,
  createInvalidPromptAgentDriverError,
  createServerErrorAgentDriverError,
} from "../mockResponsesProvider/agentDriver.ts";
import type { CodexCliActivity, CodexCliClient, CodexCliInvocation } from "./driver.ts";

/** Executable requirement declared by the Codex CLI driver. */
export const codexCliExecutableRequirements = [
  { driverName: "Codex", externalAgentKind: "codex", executableName: "codex" },
] as const;

/** Minimal JSONL object shape accepted from `codex exec --json`. */
const codexJsonRecord = Schema.Record(Schema.String, Schema.Unknown);

/** Terminal result collected from one non-interactive Codex process. */
interface CodexProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Builds `codex exec` arguments for a fresh or resumed durable session. */
export const codexCliArgv = (invocation: CodexCliInvocation): readonly string[] => {
  const shared = ["--json", "--model", invocation.model] as const;
  return Match.value(invocation.resumeSessionId).pipe(
    Match.when(undefined, () => ["exec", ...shared, "--cd", invocation.cwd, invocation.prompt]),
    Match.orElse((sessionId) => ["exec", "resume", ...shared, sessionId, invocation.prompt]),
  );
};

/** Executes one Codex process and retains both protocol output and diagnostics. */
const runCodexProcess = (invocation: CodexCliInvocation) =>
  Effect.try({
    try: () =>
      Bun.spawn(["codex", ...codexCliArgv(invocation)], {
        cwd: invocation.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: (cause) =>
      createInvalidPromptAgentDriverError({
        message: `Codex CLI failed to start: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((process) =>
      Effect.tryPromise({
        try: () =>
          Promise.all([process.exited, process.stdout.text(), process.stderr.text()]).then(
            ([exitCode, stdout, stderr]) =>
              ({ exitCode, stdout, stderr }) satisfies CodexProcessResult,
          ),
        catch: (cause) =>
          createServerErrorAgentDriverError({
            message: `Codex CLI process failed: ${String(cause)}`,
          }),
      }),
    ),
  );

/** Parses all complete Codex JSONL records with explicit malformed-output failure. */
const decodeCodexRecords = Effect.fnUntraced(function* (stdout: string) {
  return yield* Effect.forEach(
    stdout.split("\n").filter((line) => line.length > 0),
    (line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(codexJsonRecord))(line).pipe(
        Effect.mapError(() =>
          createServerErrorAgentDriverError({ message: "Codex CLI emitted malformed JSONL." }),
        ),
      ),
  );
});

/** Reads one string field from a validated Codex JSON record. */
const stringField = ({
  record,
  name,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly name: string;
}) => [record[name]].filter((value): value is string => typeof value === "string").at(0);

/** Narrows one unknown JSON value to a non-array record. */
const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Converts one completed Codex item into optional visible activity. */
const activityFromCompletedItem = (item: unknown): readonly CodexCliActivity[] =>
  Option.match(Option.fromUndefinedOr([item].filter(isUnknownRecord).at(0)), {
    onNone: () => [],
    onSome: (itemRecord) => {
      const text = stringField({ record: itemRecord, name: "text" });
      return Match.value(stringField({ record: itemRecord, name: "type" })).pipe(
        Match.when("agent_message", () =>
          Option.match(Option.fromUndefinedOr(text), {
            onNone: () => [],
            onSome: (value) => [{ _tag: "Assistant", text: value } as const],
          }),
        ),
        Match.when("reasoning", () =>
          Option.match(Option.fromUndefinedOr(text), {
            onNone: () => [],
            onSome: (value) => [{ _tag: "Reasoning", text: value } as const],
          }),
        ),
        Match.orElse(() => []),
      );
    },
  });

/** Converts known Codex JSON events into driver-local normalized activity. */
const activityFromRecord = (
  record: Readonly<Record<string, unknown>>,
): readonly CodexCliActivity[] =>
  Match.value(stringField({ record, name: "type" })).pipe(
    Match.when("item.completed", () => activityFromCompletedItem(record.item)),
    Match.when("turn.completed", () => [{ _tag: "Succeeded" } as const]),
    Match.when("turn.failed", () => [{ _tag: "Failed", message: "Codex turn failed." } as const]),
    Match.orElse(() => []),
  );

/** Extracts the durable Codex thread identifier from protocol records. */
const threadIdFromRecords = (records: readonly Readonly<Record<string, unknown>>[]) =>
  records
    .filter((record) => stringField({ record, name: "type" }) === "thread.started")
    .map((record) => stringField({ record, name: "thread_id" }))
    .find((value): value is string => value !== undefined);

/** Completed-process cancellation policy: no hidden mutation remains in flight. */
const completedCancellation = Effect.succeed<AgentCancellationOutcome>({
  _tag: "Interrupted",
  sessionReusable: true,
});

/** Live Codex CLI client using the stable JSONL exec protocol. */
export const liveCodexCliClient: CodexCliClient = {
  start: Effect.fnUntraced(function* (invocation) {
    const result = yield* runCodexProcess(invocation);
    yield* Match.value(result.exitCode).pipe(
      Match.when(0, () => Effect.succeed(result)),
      Match.orElse((exitCode) =>
        createServerErrorAgentDriverError({
          message: `Codex CLI exited with code ${exitCode}: ${result.stderr.trim()}`,
        }),
      ),
    );
    const records = yield* decodeCodexRecords(result.stdout);
    const sessionId = yield* Option.match(
      Option.fromUndefinedOr(invocation.resumeSessionId ?? threadIdFromRecords(records)),
      {
        onNone: () =>
          createServerErrorAgentDriverError({
            message: "Codex CLI did not report a durable thread identifier.",
          }),
        onSome: Effect.succeed,
      },
    );
    return {
      sessionId,
      runtimeEvents: Stream.fromIterable(records.flatMap(activityFromRecord)),
      cancel: completedCancellation,
    };
  }),
};
