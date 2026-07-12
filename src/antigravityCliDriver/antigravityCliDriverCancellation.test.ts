import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Schema, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { defaultCaaraSettingsValue } from "../caaraSettings.ts";
import type {
  AgentDriverTurn,
  AgentDriverTurnResult,
  AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import { agentTurnContextFromCodex } from "../mockResponsesProvider/codexAgentTurnContext.ts";
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
import type { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
import { makeAntigravityCliAgentDriver } from "./driver.ts";
import { fakeAgyFixture, fakeAgyScript } from "./fakeAgyScript.ts";

/** Project root used as the Codex workspace path in Antigravity cancellation tests. */
const projectRoot = process.cwd();

/** Test fixture failure for Antigravity cancellation setup and assertions. */
class AntigravityCancellationTestError extends Schema.TaggedErrorClass<AntigravityCancellationTestError>()(
  "AntigravityCancellationTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged cancellation test error. */
const cancellationTestError = (cause: unknown): AntigravityCancellationTestError =>
  new AntigravityCancellationTestError({ message: String(cause) });

/** Fixture directories and executable paths for one Antigravity cancellation test. */
interface CancellationFixture {
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
}

/** Captured fake `agy` process invocation. */
const FakeAgyInvocation = Schema.Struct({
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  prompt: Schema.String,
});

/** Captured fake process signal event proving the process exited by cancellation. */
const FakeAgySignalEvent = Schema.Struct({
  event: Schema.Literal("signal"),
  signal: Schema.String,
  mode: Schema.String,
});

/** Captured fake `agy` process invocation. */
type FakeAgyInvocation = typeof FakeAgyInvocation.Type;

/** Extracted content-delta runtime event shape used for assistant text assertions. */
type ContentDeltaEvent = Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;

/** Builds Codex identity context for one direct Antigravity driver test turn. */
const makeCodex = ({ turnId }: { readonly turnId: string }): CodexTurnContext =>
  new CodexTurnContext({
    parentSessionId: "parent-session-agy-cancel",
    threadId: "codex-thread-agy-cancel",
    turnId,
    parentThreadId: "parent-thread-agy-cancel",
    windowId: "window-agy-cancel",
    requestKind: "turn",
    subagentKind: "caara",
    originator: "codex_cli_rs",
    requestedModel: "agy/gemini-3.5-flash",
    sandboxPosture: "enforced",
    workspacePaths: [projectRoot],
    cwdCandidates: [projectRoot],
  });

/** Builds one selected Antigravity target for direct driver cancellation tests. */
const makeTarget = (): AgentTarget =>
  new AgentTarget({
    requestedModel: "agy/gemini-3.5-flash",
    externalAgentKind: "agy",
    externalModelSpecifier: "gemini-3.5-flash",
    rawDriverOptions: {},
  });

/** Returns the previous target only when the turn carries a durable external session. */
const previousTargetForSession = (
  externalSession: DurableExternalSession | undefined,
): AgentTarget | undefined =>
  Match.value(externalSession).pipe(
    Match.when(undefined, () => undefined),
    Match.orElse(() => makeTarget()),
  );

/** Builds one direct Antigravity driver turn with a latest-user prompt. */
const makeTurn = ({
  turnId,
  externalSession,
}: {
  readonly turnId: string;
  readonly externalSession?: DurableExternalSession;
}): AgentDriverTurn => ({
  context: agentTurnContextFromCodex({ codex: makeCodex({ turnId }) }),
  target: makeTarget(),
  prompt: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `cancel ${turnId}` }],
      },
    ],
  },
  cwd: projectRoot,
  requestedCwd: projectRoot,
  previousTarget: previousTargetForSession(externalSession),
  externalSession,
});

/** Creates a fresh project-local fake Antigravity executable fixture. */
const makeFixture = Effect.fnUntraced(function* () {
  const tempRoot = path.join(
    projectRoot,
    "temp.local",
    "2026-06-23",
    "antigravity-cli-cancellation-tests",
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: cancellationTestError,
  });
  const root = yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `fixture-${randomUUID()}-`)),
    catch: cancellationTestError,
  });
  const fakeHomeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const fakeAgyPath = path.join(binDir, "agy");
  const invocationLogPath = path.join(root, "invocations.jsonl");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(binDir, { recursive: true }),
    catch: cancellationTestError,
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(fakeAgyPath, fakeAgyScript, { mode: 0o755 }),
    catch: cancellationTestError,
  });
  return { fakeAgyPath, fakeHomeDir, invocationLogPath } satisfies CancellationFixture;
});

/** Pre-seeds the fake diagnostic log so Effect test-clock retries are not required. */
const writeDiagnosticLog = Effect.fnUntraced(function* ({
  fixture,
  turnId,
}: {
  readonly fixture: CancellationFixture;
  readonly turnId: string;
}) {
  const logPath = path.join(
    fixture.fakeHomeDir,
    ".caara",
    "antigravity-cli",
    "logs",
    `${turnId}.log`,
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(logPath), { recursive: true }),
    catch: cancellationTestError,
  });
  yield* Effect.tryPromise({
    try: () =>
      fs.writeFile(
        logPath,
        `I0622 20:09:01.708030 server.go:789] Created conversation ${fakeAgyFixture.conversationId}\n`,
      ),
    catch: cancellationTestError,
  });
});

/** Builds the canonical fake Antigravity transcript path for one fixture. */
const transcriptPath = ({ fixture }: { readonly fixture: CancellationFixture }): string =>
  path.join(
    fixture.fakeHomeDir,
    ".gemini",
    "antigravity-cli",
    "brain",
    fakeAgyFixture.conversationId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );

/** Options shared by text-file readiness waits. */
interface TextFileWaitOptions {
  readonly filePath: string;
  readonly predicate: (content: string) => boolean;
  readonly message: string;
}

/** Options for one bounded text-file readiness wait attempt. */
interface TextFileWaitAttemptOptions extends TextFileWaitOptions {
  readonly remainingAttempts: number;
}

/** Schedules the next text-file readiness check or rejects when attempts are exhausted. */
const retryTextFilePromise = ({
  filePath,
  predicate,
  message,
  remainingAttempts,
  reject,
  resolve,
}: TextFileWaitAttemptOptions & {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
}): void => {
  const next = Match.value(remainingAttempts <= 0).pipe(
    Match.when(true, () => () => {
      reject(new Error(message));
    }),
    Match.orElse(() => () => {
      setTimeout(() => {
        checkTextFilePromise({
          filePath,
          predicate,
          message,
          remainingAttempts: remainingAttempts - 1,
          reject,
          resolve,
        });
      }, 5);
    }),
  );
  next();
};

/** Checks whether a text file is ready and otherwise schedules another check. */
const checkTextFilePromise = ({
  filePath,
  predicate,
  message,
  remainingAttempts,
  reject,
  resolve,
}: TextFileWaitAttemptOptions & {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
}): void => {
  fs.readFile(filePath, "utf8")
    .then((content) => {
      const next = Match.value(predicate(content)).pipe(
        Match.when(true, () => () => {
          resolve();
        }),
        Match.orElse(() => () => {
          retryTextFilePromise({
            filePath,
            predicate,
            message,
            remainingAttempts,
            reject,
            resolve,
          });
        }),
      );
      next();
    })
    .catch(() => {
      retryTextFilePromise({ filePath, predicate, message, remainingAttempts, reject, resolve });
    });
};

/** Waits for a text file readiness predicate using real timers outside Effect TestClock. */
const waitForTextFilePromise = ({
  filePath,
  predicate,
  message,
  remainingAttempts,
}: TextFileWaitAttemptOptions): Promise<void> =>
  new Promise((resolve, reject) => {
    checkTextFilePromise({ filePath, predicate, message, remainingAttempts, reject, resolve });
  });

/** Waits for a text file to satisfy one fixture-local readiness predicate. */
const waitForTextFile = Effect.fnUntraced(function* (options: TextFileWaitOptions) {
  return yield* Effect.tryPromise({
    try: () => waitForTextFilePromise({ ...options, remainingAttempts: 400 }),
    catch: () => new AntigravityCancellationTestError({ message: options.message }),
  });
});

/** Waits until the fake process records its invocation. */
const waitForFakeInvocation = ({ fixture }: { readonly fixture: CancellationFixture }) =>
  waitForTextFile({
    filePath: fixture.invocationLogPath,
    predicate: (content) => content.length > 0,
    message: "Timed out waiting for fake agy invocation.",
  });

/** Waits until the fake process writes any transcript bytes. */
const waitForTranscriptMutation = ({ fixture }: { readonly fixture: CancellationFixture }) =>
  waitForTextFile({
    filePath: transcriptPath({ fixture }),
    predicate: (content) => content.length > 0,
    message: "Timed out waiting for fake Antigravity transcript mutation.",
  });

/** Starts one direct Antigravity driver turn through the fake process fixture. */
const startDriverTurn = Effect.fnUntraced(function* ({
  fixture,
  fakeMode,
  turn,
}: {
  readonly fixture: CancellationFixture;
  readonly fakeMode: string;
  readonly turn: AgentDriverTurn;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const driver = makeAntigravityCliAgentDriver({
    caaraSettings: defaultCaaraSettingsValue,
    fileSystem,
    pathService,
    spawner,
    settings: {
      command: fixture.fakeAgyPath,
      homeDir: fixture.fakeHomeDir,
      environment: {
        AGY_FAKE_INVOCATION_LOG: fixture.invocationLogPath,
        AGY_FAKE_MODE: fakeMode,
      },
    },
  });
  return yield* driver.startOrResumeTurn(turn);
});

/** Runs one completed Antigravity turn and returns the assistant text. */
const runCompletedTurn = Effect.fnUntraced(function* ({
  fixture,
  fakeMode,
  turn,
}: {
  readonly fixture: CancellationFixture;
  readonly fakeMode: string;
  readonly turn: AgentDriverTurn;
}) {
  const result = yield* startDriverTurn({ fixture, fakeMode, turn });
  const events = yield* result.runtimeEvents.pipe(
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  );
  return events
    .filter((event): event is ContentDeltaEvent => event._tag === "ContentDelta")
    .map((event) => event.text)
    .join("");
});

/** Extracts a durable external session from one driver result. */
const durableSessionFromResult = (result: AgentDriverTurnResult): DurableExternalSession =>
  Match.valueTags(result.externalSession, {
    Durable: (session) => session,
    Ephemeral: () => assert.fail("expected durable Antigravity external session"),
  });

/** Reads all JSONL records emitted by the fake `agy` script. */
const readFakeLogLines = Effect.fnUntraced(function* ({
  invocationLogPath,
}: {
  readonly invocationLogPath: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(invocationLogPath, "utf8"),
    catch: cancellationTestError,
  });
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return yield* Effect.forEach(lines, (line) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line),
  );
});

/** Reads all fake process invocation records. */
const readFakeInvocations = Effect.fnUntraced(function* ({
  invocationLogPath,
}: {
  readonly invocationLogPath: string;
}) {
  const lines = yield* readFakeLogLines({ invocationLogPath });
  return lines.filter(Schema.is(FakeAgyInvocation));
});

/** Reads all fake process signal records. */
const readFakeSignalEvents = Effect.fnUntraced(function* ({
  invocationLogPath,
}: {
  readonly invocationLogPath: string;
}) {
  const lines = yield* readFakeLogLines({ invocationLogPath });
  return lines.filter(Schema.is(FakeAgySignalEvent));
});

/** Returns the final fake process invocation recorded by the fixture. */
const lastInvocation = (invocations: readonly FakeAgyInvocation[]): FakeAgyInvocation => {
  const invocation = invocations.at(-1);
  assert.ok(invocation, "expected at least one fake agy invocation");
  return invocation;
};

describe("Antigravity CLI driver cancellation", () => {
  it.effect("preserves the binding when cancellation happens before transcript mutation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* writeDiagnosticLog({ fixture, turnId: "turn-agy-cancel-before-transcript" });
      const result = yield* startDriverTurn({
        fixture,
        fakeMode: "cancel-before-transcript",
        turn: makeTurn({ turnId: "turn-agy-cancel-before-transcript" }),
      });
      yield* waitForFakeInvocation({ fixture });
      const outcome = yield* result.cancel;

      assert.deepStrictEqual(outcome, { _tag: "Interrupted", sessionReusable: true });

      const resumedText = yield* runCompletedTurn({
        fixture,
        fakeMode: "resume-success",
        turn: makeTurn({
          turnId: "turn-agy-after-reusable-cancel",
          externalSession: durableSessionFromResult(result),
        }),
      });
      const invocations = yield* readFakeInvocations({
        invocationLogPath: fixture.invocationLogPath,
      });
      const signals = yield* readFakeSignalEvents({ invocationLogPath: fixture.invocationLogPath });

      assert.strictEqual(resumedText, fakeAgyFixture.resumedAnswer);
      assert.ok(lastInvocation(invocations).args.includes("--conversation"));
      assert.deepStrictEqual(
        signals.map((event) => [event.mode, event.signal]),
        [["cancel-before-transcript", "SIGTERM"]],
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("drops the binding when cancellation happens after transcript mutation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* writeDiagnosticLog({ fixture, turnId: "turn-agy-cancel-after-transcript" });
      const result = yield* startDriverTurn({
        fixture,
        fakeMode: "cancel-after-transcript",
        turn: makeTurn({ turnId: "turn-agy-cancel-after-transcript" }),
      });
      yield* waitForTranscriptMutation({ fixture });
      const outcome = yield* result.cancel;

      assert.deepStrictEqual(outcome, { _tag: "Terminated", sessionReusable: false });

      const freshText = yield* runCompletedTurn({
        fixture,
        fakeMode: "success",
        turn: makeTurn({ turnId: "turn-agy-after-nonreusable-cancel" }),
      });
      const invocations = yield* readFakeInvocations({
        invocationLogPath: fixture.invocationLogPath,
      });

      assert.strictEqual(freshText, fakeAgyFixture.finalAnswer);
      assert.ok(!lastInvocation(invocations).args.includes("--conversation"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("treats in-flight activity transcript bytes as non-reusable cancellation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* writeDiagnosticLog({ fixture, turnId: "turn-agy-cancel-during-activity" });
      const result = yield* startDriverTurn({
        fixture,
        fakeMode: "cancel-during-activity",
        turn: makeTurn({ turnId: "turn-agy-cancel-during-activity" }),
      });
      yield* waitForTranscriptMutation({ fixture });
      const outcome = yield* result.cancel;
      const signals = yield* readFakeSignalEvents({ invocationLogPath: fixture.invocationLogPath });

      assert.deepStrictEqual(outcome, { _tag: "Terminated", sessionReusable: false });
      assert.deepStrictEqual(
        signals.map((event) => [event.mode, event.signal]),
        [["cancel-during-activity", "SIGTERM"]],
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
