import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Match, Option, Schema, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

import { defaultCaaraSettingsValue } from "../caaraSettings.ts";
import type {
  AgentDriverTurn,
  AgentDriverTurnResult,
  AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
import type { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
import { makeAntigravityCliAgentDriver } from "./driver.ts";
import { fakeAgyFixture, fakeAgyScript } from "./fakeAgyScript.ts";

/** Project root used as the Codex workspace path in Antigravity live cancellation tests. */
const projectRoot = process.cwd();

/** Test fixture failure for Antigravity live cancellation setup and assertions. */
class AntigravityLiveCancellationTestError extends Schema.TaggedErrorClass<AntigravityLiveCancellationTestError>()(
  "AntigravityLiveCancellationTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged live cancellation test error. */
const liveCancellationTestError = (cause: unknown): AntigravityLiveCancellationTestError =>
  new AntigravityLiveCancellationTestError({ message: String(cause) });

/** Fixture directories and executable paths for one Antigravity live cancellation test. */
interface LiveCancellationFixture {
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
}

/** Captured fake process signal event proving the process exited by cancellation. */
const FakeAgySignalEvent = Schema.Struct({
  event: Schema.Literal("signal"),
  signal: Schema.String,
  mode: Schema.String,
});

/** Extracted content-delta runtime event shape used for assistant text assertions. */
type ContentDeltaEvent = Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;

/** Builds Codex identity context for one direct Antigravity live cancellation turn. */
const makeCodex = ({ turnId }: { readonly turnId: string }): CodexTurnContext =>
  new CodexTurnContext({
    parentSessionId: "parent-session-agy-live-cancel",
    threadId: "codex-thread-agy-live-cancel",
    turnId,
    parentThreadId: "parent-thread-agy-live-cancel",
    windowId: "window-agy-live-cancel",
    requestKind: "turn",
    subagentKind: "caara",
    originator: "codex_cli_rs",
    requestedModel: "agy/gemini-3.5-flash",
    sandboxPosture: "enforced",
    workspacePaths: [projectRoot],
    cwdCandidates: [projectRoot],
  });

/** Builds one selected Antigravity target for direct driver live cancellation tests. */
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
  codex: makeCodex({ turnId }),
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
    "antigravity-cli-live-cancellation-tests",
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: liveCancellationTestError,
  });
  const root = yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `fixture-${randomUUID()}-`)),
    catch: liveCancellationTestError,
  });
  const fakeHomeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const fakeAgyPath = path.join(binDir, "agy");
  const invocationLogPath = path.join(root, "invocations.jsonl");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(binDir, { recursive: true }),
    catch: liveCancellationTestError,
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(fakeAgyPath, fakeAgyScript, { mode: 0o755 }),
    catch: liveCancellationTestError,
  });
  return { fakeAgyPath, fakeHomeDir, invocationLogPath } satisfies LiveCancellationFixture;
});

/** Pre-seeds the fake diagnostic log so Effect test-clock retries are not required. */
const writeDiagnosticLog = Effect.fnUntraced(function* ({
  fixture,
  turnId,
}: {
  readonly fixture: LiveCancellationFixture;
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
    catch: liveCancellationTestError,
  });
  yield* Effect.tryPromise({
    try: () =>
      fs.writeFile(
        logPath,
        `I0622 20:09:01.708030 server.go:789] Created conversation ${fakeAgyFixture.conversationId}\n`,
      ),
    catch: liveCancellationTestError,
  });
});

/** Builds the canonical fake Antigravity transcript path for one fixture. */
const transcriptPath = ({ fixture }: { readonly fixture: LiveCancellationFixture }): string =>
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

/** Fixture-local path used to release the fake out-of-order streaming process. */
const outOfOrderContinuePath = ({
  fixture,
}: {
  readonly fixture: LiveCancellationFixture;
}): string => path.join(fixture.fakeHomeDir, ".caara", "antigravity-cli", "continue-out-of-order");

/** Releases a fake Antigravity process waiting after an out-of-order transcript write. */
const releaseOutOfOrderStreamingProcess = Effect.fnUntraced(function* ({
  fixture,
}: {
  readonly fixture: LiveCancellationFixture;
}) {
  const continuePath = outOfOrderContinuePath({ fixture });
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(continuePath), { recursive: true }),
    catch: liveCancellationTestError,
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(continuePath, "continue"),
    catch: liveCancellationTestError,
  });
});

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
      globalThis.setTimeout(() => {
        checkTextFilePromise({
          filePath,
          predicate,
          message,
          remainingAttempts: remainingAttempts - 1,
          reject,
          resolve,
        });
      }, 10);
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
    catch: () => new AntigravityLiveCancellationTestError({ message: options.message }),
  });
});

/** Waits until the fake process writes any transcript bytes. */
const waitForTranscriptMutation = ({ fixture }: { readonly fixture: LiveCancellationFixture }) =>
  waitForTextFile({
    filePath: transcriptPath({ fixture }),
    predicate: (content) => content.length > 0,
    message: "Timed out waiting for fake Antigravity transcript mutation.",
  });

/** Waits until the fake transcript contains one expected marker. */
const waitForTranscriptText = ({
  fixture,
  text,
}: {
  readonly fixture: LiveCancellationFixture;
  readonly text: string;
}) =>
  waitForTextFile({
    filePath: transcriptPath({ fixture }),
    predicate: (content) => content.includes(text),
    message: `Timed out waiting for fake Antigravity transcript marker: ${text}.`,
  });

/** Starts one direct Antigravity driver turn through the fake process fixture. */
const startDriverTurn = Effect.fnUntraced(function* ({
  fixture,
  fakeMode,
  turn,
}: {
  readonly fixture: LiveCancellationFixture;
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

/** Extracts a durable external session from one driver result. */
const durableSessionFromResult = (result: AgentDriverTurnResult): DurableExternalSession =>
  Match.valueTags(result.externalSession, {
    Durable: (session) => session,
    Ephemeral: () => assert.fail("expected durable Antigravity external session"),
  });

/** Reads all fake process signal records. */
const readFakeSignalEvents = Effect.fnUntraced(function* ({
  invocationLogPath,
}: {
  readonly invocationLogPath: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(invocationLogPath, "utf8"),
    catch: liveCancellationTestError,
  });
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const records = yield* Effect.forEach(lines, (line) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line),
  );
  return records.filter(Schema.is(FakeAgySignalEvent));
});

/** Returns visible assistant content-delta text from one runtime event list. */
const contentDeltaTexts = (events: readonly AgentRuntimeEvent[]): readonly string[] =>
  events
    .filter((event): event is ContentDeltaEvent => event._tag === "ContentDelta")
    .map((event) => event.text);

describe("Antigravity CLI driver live cancellation", () => {
  it.effect("relays transcript activity before the fake process exits", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* writeDiagnosticLog({ fixture, turnId: "turn-agy-stream-live-activity" });
      const result = yield* startDriverTurn({
        fixture,
        fakeMode: "streaming-activity-before-exit",
        turn: makeTurn({ turnId: "turn-agy-stream-live-activity" }),
      });
      const activityFiber = yield* result.runtimeEvents.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkDetach({ startImmediately: true }),
      );
      const activityExitEffect = Fiber.await(activityFiber).pipe(Effect.timeoutOption("1 second"));
      const joinedEventsEffect = Fiber.join(activityFiber).pipe(Effect.map((chunk) => [...chunk]));
      const ignoreCancel = result.cancel.pipe(Effect.ignore);
      yield* waitForTranscriptMutation({ fixture }).pipe(
        Effect.flatMap(() => activityExitEffect),
        Effect.tap((activityExit) =>
          Effect.sync(() => {
            assert.ok(
              Option.isSome(activityExit),
              "expected activity events before fake agy process exit",
            );
          }),
        ),
        Effect.flatMap(() => joinedEventsEffect),
        Effect.tap((events) =>
          Effect.sync(() => {
            assert.deepStrictEqual(
              events
                .filter((event): event is ContentDeltaEvent => event._tag === "ContentDelta")
                .map((event) => event.text),
              ["Listing `src`"],
            );
          }),
        ),
        Effect.ensuring(ignoreCancel),
      );
    }).pipe(Effect.provide(BunServices.layer), TestClock.withLive),
  );

  it.effect("buffers out-of-order live transcript rows until planner context arrives", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* writeDiagnosticLog({ fixture, turnId: "turn-agy-live-out-of-order" });
      const result = yield* startDriverTurn({
        fixture,
        fakeMode: "streaming-out-of-order-before-exit",
        turn: makeTurn({ turnId: "turn-agy-live-out-of-order" }),
      });
      const observedEvents: AgentRuntimeEvent[] = [];
      const eventsFiber = yield* result.runtimeEvents.pipe(
        Stream.tap((event) => Effect.sync(() => observedEvents.push(event))),
        Stream.runCollect,
        Effect.forkDetach({ startImmediately: true }),
      );

      yield* waitForTranscriptText({
        fixture,
        text: "RAW_OUT_OF_ORDER_DIRECTORY_SHOULD_NOT_LEAK",
      });
      yield* Effect.sleep("100 millis");
      assert.deepStrictEqual(
        contentDeltaTexts(observedEvents),
        [],
        "expected out-of-order result row to stay buffered until planner row arrives",
      );

      yield* releaseOutOfOrderStreamingProcess({ fixture });
      const events = yield* Fiber.join(eventsFiber).pipe(
        Effect.timeout("2 seconds"),
        Effect.map((chunk) => [...chunk]),
      );
      const visibleText = contentDeltaTexts(events).join("\n");

      assert.ok(!visibleText.includes("RAW_OUT_OF_ORDER_DIRECTORY_SHOULD_NOT_LEAK"));
      assert.deepStrictEqual(contentDeltaTexts(events), [
        "Listing `src`",
        "out-of-order live reasoning",
        "out-of-order live final",
      ]);
      assert.ok(!visibleText.includes("Listing directory"));
    }).pipe(Effect.provide(BunServices.layer), TestClock.withLive),
  );

  it.effect("returns a cancellable resumed turn before the resumed process exits", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* startDriverTurn({
        fixture,
        fakeMode: "success",
        turn: makeTurn({ turnId: "turn-agy-resume-cancel-seed" }),
      });
      yield* first.runtimeEvents.pipe(Stream.runCollect);
      const resumeFiber = yield* startDriverTurn({
        fixture,
        fakeMode: "resume-cancel-after-transcript",
        turn: makeTurn({
          turnId: "turn-agy-resume-cancel-after-transcript",
          externalSession: durableSessionFromResult(first),
        }),
      }).pipe(Effect.forkDetach({ startImmediately: true }));

      yield* waitForTranscriptText({
        fixture,
        text: "partial resumed cancelled answer",
      });
      const startExit = yield* Fiber.await(resumeFiber).pipe(Effect.timeoutOption("300 millis"));
      const result = yield* Fiber.join(resumeFiber);
      const outcome = yield* result.cancel;
      const signals = yield* readFakeSignalEvents({ invocationLogPath: fixture.invocationLogPath });

      assert.ok(
        Option.isSome(startExit),
        "expected resumed start to return before fake agy process exit",
      );
      assert.deepStrictEqual(outcome, { _tag: "Terminated", sessionReusable: false });
      assert.deepStrictEqual(
        signals.map((event) => [event.mode, event.signal]),
        [["resume-cancel-after-transcript", "SIGTERM"]],
      );
    }).pipe(Effect.provide(BunServices.layer), TestClock.withLive),
  );
});
