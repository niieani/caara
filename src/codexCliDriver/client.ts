import { type Cause, Deferred, Effect, Match, Option, Queue, Schema, Stream } from "effect";

import {
  type AgentCancellationOutcome,
  type AgentDriverError,
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

/** Process capabilities required by the live Codex protocol adapter. */
export interface CodexCliProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderrText: () => Promise<string>;
  readonly exited: Promise<number>;
  readonly kill: (signal: NodeJS.Signals) => void;
}

/** Injectable process constructor used to test the Codex IO boundary causally. */
export type CodexCliSpawn = (invocation: CodexCliInvocation) => CodexCliProcess;

/** Builds `codex exec` arguments for a fresh or resumed durable session. */
export const codexCliArgv = (invocation: CodexCliInvocation): readonly string[] => {
  const shared = ["--json", "--model", invocation.model] as const;
  return Match.value(invocation.resumeSessionId).pipe(
    Match.when(undefined, () => ["exec", ...shared, "--cd", invocation.cwd, invocation.prompt]),
    Match.orElse((sessionId) => ["exec", "resume", ...shared, sessionId, invocation.prompt]),
  );
};

/** Builds recursion metadata inherited by Codex and nested Caara invocations. */
export const codexCliEnvironment = (
  invocation: CodexCliInvocation,
): Readonly<Record<string, string>> => ({
  CAARA_DELEGATION_LINEAGE: invocation.lineage.join(","),
  CAARA_DELEGATION_DEPTH: String(invocation.depth),
});

/** Starts the real Codex executable with piped protocol and diagnostic channels. */
const spawnLiveCodex: CodexCliSpawn = (invocation) => {
  const process = Bun.spawn(["codex", ...codexCliArgv(invocation)], {
    cwd: invocation.cwd,
    env: { ...globalThis.process.env, ...codexCliEnvironment(invocation) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: process.stdout,
    stderrText: () => process.stderr.text(),
    exited: process.exited,
    kill: (signal) => process.kill(signal),
  };
};

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

/** Decodes one newline-complete Codex protocol record. */
const decodeCodexRecord = (line: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(codexJsonRecord))(line).pipe(
    Effect.mapError(() =>
      createServerErrorAgentDriverError({ message: "Codex CLI emitted malformed JSONL." }),
    ),
  );

/** Converts a process stdout channel into complete decoded JSONL records. */
const codexRecordStream = (process: CodexCliProcess) =>
  Stream.fromReadableStream({
    evaluate: () => process.stdout,
    onError: (cause) =>
      createServerErrorAgentDriverError({
        message: `Codex CLI protocol stream failed: ${String(cause)}`,
      }),
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect(decodeCodexRecord),
  );

/** Reports process completion through a stable driver diagnostic. */
const validateProcessExit = Effect.fnUntraced(function* (process: CodexCliProcess) {
  const exitCode = yield* Effect.tryPromise({
    try: () => process.exited,
    catch: (cause) =>
      createServerErrorAgentDriverError({
        message: `Codex CLI process failed: ${String(cause)}`,
      }),
  });
  return yield* Match.value(exitCode).pipe(
    Match.when(0, () => Effect.void),
    Match.orElse(
      Effect.fnUntraced(function* (failedExitCode) {
        const stderr = yield* Effect.tryPromise({
          try: process.stderrText,
          catch: (cause) =>
            createServerErrorAgentDriverError({
              message: `Codex CLI diagnostic stream failed: ${String(cause)}`,
            }),
        });
        return yield* createServerErrorAgentDriverError({
          message: `Codex CLI exited with code ${failedExitCode}: ${stderr.trim()}`,
        });
      }),
    ),
  );
});

/** Fails a completed protocol stream that never established a durable session. */
const ensureSessionReported = Effect.fnUntraced(function* (
  session: Deferred.Deferred<string, AgentDriverError>,
) {
  const started = yield* Deferred.isDone(session);
  return yield* Match.value(started).pipe(
    Match.when(true, () => Effect.void),
    Match.orElse(() =>
      createServerErrorAgentDriverError({
        message: "Codex CLI did not report a durable thread identifier.",
      }),
    ),
  );
});

/** Creates a streaming Codex client around an injectable process boundary. */
export const createCodexCliClient = ({
  spawn,
}: {
  readonly spawn: CodexCliSpawn;
}): CodexCliClient => ({
  start: Effect.fnUntraced(function* (invocation) {
    const process = yield* Effect.try({
      try: () => spawn(invocation),
      catch: (cause) =>
        createInvalidPromptAgentDriverError({
          message: `Codex CLI failed to start: ${String(cause)}`,
        }),
    });
    const session = yield* Deferred.make<string, AgentDriverError>();
    const activities = yield* Queue.unbounded<CodexCliActivity, AgentDriverError | Cause.Done>();
    const observe = codexRecordStream(process).pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (record) {
          if (stringField({ record, name: "type" }) === "thread.started") {
            const threadId = stringField({ record, name: "thread_id" });
            if (threadId === undefined) {
              return yield* createServerErrorAgentDriverError({
                message: "Codex CLI reported thread.started without a durable thread identifier.",
              });
            }
            yield* Deferred.succeed(session, threadId);
          }
          yield* Queue.offerAll(activities, activityFromRecord(record));
        }),
      ),
      Effect.andThen(validateProcessExit(process)),
      Effect.andThen(ensureSessionReported(session)),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.all([Deferred.fail(session, error), Queue.fail(activities, error)]).pipe(
            Effect.asVoid,
          ),
        onSuccess: () => Queue.end(activities).pipe(Effect.asVoid),
      }),
    );
    yield* Effect.forkDetach(observe);
    const sessionId = yield* Deferred.await(session);
    const cancel = Effect.fnUntraced(function* () {
      yield* Effect.sync(() => process.kill("SIGTERM"));
      yield* Effect.promise(() => process.exited);
      return {
        _tag: "Terminated",
        sessionReusable: false,
      } satisfies AgentCancellationOutcome;
    })();
    return {
      sessionId,
      runtimeEvents: Stream.fromQueue(activities),
      cancel,
    };
  }),
});

/** Live Codex CLI client using the stable streaming JSONL exec protocol. */
export const liveCodexCliClient: CodexCliClient = createCodexCliClient({ spawn: spawnLiveCodex });
