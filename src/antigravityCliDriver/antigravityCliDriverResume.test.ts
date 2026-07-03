import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Option, Schema, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { defaultCaaraSettingsValue } from "../caaraSettings.ts";
import type {
  AgentDriverTurn,
  AgentDriverTurnResult,
  AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import { decodeAntigravityDriverResumeCursor } from "./cursor.ts";
import { makeAntigravityCliAgentDriver } from "./driver.ts";
import { fakeAgyFixture, fakeAgyScript } from "./fakeAgyScript.ts";

/** Project root used as the Codex workspace path in Antigravity resume tests. */
const projectRoot = process.cwd();

/** Test fixture failure for Antigravity resume setup and invocation inspection. */
class AntigravityResumeTestError extends Schema.TaggedErrorClass<AntigravityResumeTestError>()(
  "AntigravityResumeTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged Antigravity resume test error. */
const testError = (cause: unknown): AntigravityResumeTestError =>
  new AntigravityResumeTestError({ message: String(cause) });

/** Captured fake `agy` process invocation. */
const FakeAgyInvocation = Schema.Struct({
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  prompt: Schema.String,
});

/** Extracted content-delta runtime event shape used for assistant text assertions. */
type ContentDeltaEvent = Extract<AgentRuntimeEvent, { readonly _tag: "ContentDelta" }>;

/** Fixture directories and executable paths shared across one Antigravity resume test. */
interface ResumeFixture {
  readonly fakeAgyPath: string;
  readonly fakeHomeDir: string;
  readonly invocationLogPath: string;
}

/** Builds Codex identity context for one direct Antigravity driver test turn. */
const makeCodex = ({ turnId }: { readonly turnId: string }): CodexTurnContext =>
  new CodexTurnContext({
    parentSessionId: "parent-session-agy-resume",
    threadId: "codex-thread-agy-resume",
    turnId,
    parentThreadId: "parent-thread-agy-resume",
    windowId: "window-agy-resume",
    requestKind: "turn",
    subagentKind: "caara",
    originator: "codex_cli_rs",
    requestedModel: "agy/gemini-3.5-flash",
    sandboxPosture: "enforced",
    workspacePaths: [projectRoot],
    cwdCandidates: [projectRoot],
  });

/** Builds one selected Antigravity target for direct driver tests. */
const makeTarget = ({
  rawDriverOptions = {},
}: {
  readonly rawDriverOptions?: Readonly<Record<string, string>>;
} = {}): AgentTarget =>
  new AgentTarget({
    requestedModel: "agy/gemini-3.5-flash",
    externalAgentKind: "agy",
    externalModelSpecifier: "gemini-3.5-flash",
    rawDriverOptions,
  });

/** Returns the previous target only when the test turn has an existing external session. */
const previousTargetForSession = (
  externalSession: DurableExternalSession | undefined,
): AgentTarget | undefined =>
  Option.match(Option.fromUndefinedOr(externalSession), {
    onNone: () => undefined,
    onSome: () => makeTarget(),
  });

/** Builds one direct Antigravity driver turn with a latest-user prompt. */
const makeTurn = ({
  turnId,
  externalSession,
  rawDriverOptions,
}: {
  readonly turnId: string;
  readonly externalSession?: DurableExternalSession;
  readonly rawDriverOptions?: Readonly<Record<string, string>>;
}): AgentDriverTurn => ({
  codex: makeCodex({ turnId }),
  target: makeTarget({ rawDriverOptions }),
  prompt: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `turn ${turnId}` }],
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
    "antigravity-cli-resume-tests",
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: testError,
  });
  const root = yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `fixture-${randomUUID()}-`)),
    catch: testError,
  });
  const fakeHomeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const fakeAgyPath = path.join(binDir, "agy");
  const invocationLogPath = path.join(root, "invocations.jsonl");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(binDir, { recursive: true }),
    catch: testError,
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(fakeAgyPath, fakeAgyScript, { mode: 0o755 }),
    catch: testError,
  });
  return { fakeAgyPath, fakeHomeDir, invocationLogPath } satisfies ResumeFixture;
});

/** Reads all fake `agy` invocations recorded by the fixture executable. */
const readFakeInvocations = Effect.fnUntraced(function* ({
  invocationLogPath,
}: {
  readonly invocationLogPath: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(invocationLogPath, "utf8"),
    catch: testError,
  });
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return yield* Effect.forEach(lines, (line) =>
    Schema.decodeEffect(Schema.fromJsonString(FakeAgyInvocation))(line),
  );
});

/** Returns the value following one argv flag. */
const argValue = (args: readonly string[], flag: string): string | undefined =>
  args.at(args.indexOf(flag) + 1);

/** Returns the assistant text assembled from driver runtime content deltas. */
const assistantTextFromEvents = (events: readonly AgentRuntimeEvent[]): string =>
  events
    .filter((event): event is ContentDeltaEvent => event._tag === "ContentDelta")
    .map((event) => event.text)
    .join("");

/** Extracts the Antigravity conversation id from a durable driver result cursor. */
const durableConversationId = Effect.fnUntraced(function* (result: AgentDriverTurnResult) {
  const session = durableSessionFromResult(result);
  return yield* decodeAntigravityDriverResumeCursor(session.driverResumeCursor).pipe(
    Effect.map((cursor) => cursor.conversationId),
  );
});

/** Extracts a durable external session from one driver result. */
const durableSessionFromResult = (result: AgentDriverTurnResult): DurableExternalSession =>
  Match.valueTags(result.externalSession, {
    Durable: (session) => session,
    Ephemeral: () => assert.fail("expected durable Antigravity external session"),
  });

/** Runs one direct Antigravity driver turn through the fake process fixture. */
const runDriverTurn = ({
  fixture,
  fakeMode,
  turn,
}: {
  readonly fixture: ResumeFixture;
  readonly fakeMode: string;
  readonly turn: AgentDriverTurn;
}) =>
  Effect.gen(function* () {
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
    const result = yield* driver.startOrResumeTurn(turn);
    const events = yield* result.runtimeEvents.pipe(
      Stream.runCollect,
      Effect.map((chunk) => [...chunk]),
    );
    return {
      result,
      events,
      assistantText: assistantTextFromEvents(events),
    };
  }).pipe(Effect.provide(BunServices.layer));

describe("Antigravity CLI driver resume", () => {
  it.effect("does not recover resumed invalid driver options", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* runDriverTurn({
        fixture,
        fakeMode: "success",
        turn: makeTurn({ turnId: "turn-resume-invalid-option-seed" }),
      });
      const failure = yield* Effect.flip(
        runDriverTurn({
          fixture,
          fakeMode: "fresh-recovery-success",
          turn: makeTurn({
            turnId: "turn-resume-invalid-option-followup",
            externalSession: durableSessionFromResult(first.result),
            rawDriverOptions: { "permission-mode": "auto" },
          }),
        }),
      );

      assert.strictEqual(failure.responseErrorCode, "invalid_prompt");
      assert.strictEqual(
        failure.message,
        "Unsupported Antigravity driver option: permission-mode.",
      );
    }),
  );

  it.effect("resumes stored cursor with --conversation and emits appended transcript records", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* runDriverTurn({
        fixture,
        fakeMode: "success",
        turn: makeTurn({ turnId: "turn-resume-seed" }),
      });
      assert.strictEqual(first.assistantText, fakeAgyFixture.finalAnswer);

      const second = yield* runDriverTurn({
        fixture,
        fakeMode: "resume-success",
        turn: makeTurn({
          turnId: "turn-resume-followup",
          externalSession: durableSessionFromResult(first.result),
        }),
      });
      assert.strictEqual(second.assistantText, fakeAgyFixture.resumedAnswer);
      assert.strictEqual(
        yield* durableConversationId(second.result),
        fakeAgyFixture.conversationId,
      );

      const invocations = yield* readFakeInvocations({
        invocationLogPath: fixture.invocationLogPath,
      });
      const resumeInvocation = invocations.at(1);
      assert.ok(resumeInvocation, "missing resume invocation");
      assert.deepStrictEqual(resumeInvocation.args.slice(0, 4), [
        "--prompt",
        "turn turn-resume-followup",
        "--conversation",
        fakeAgyFixture.conversationId,
      ]);
      assert.match(argValue(resumeInvocation.args, "--log-file") ?? "", /turn-resume-followup/u);
    }),
  );

  it.effect("does not reuse old transcript records when a resumed turn has no final answer", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* runDriverTurn({
        fixture,
        fakeMode: "success",
        turn: makeTurn({ turnId: "turn-resume-missing-final-seed" }),
      });
      const failure = yield* Effect.flip(
        runDriverTurn({
          fixture,
          fakeMode: "resume-missing-final",
          turn: makeTurn({
            turnId: "turn-resume-missing-final-followup",
            externalSession: durableSessionFromResult(first.result),
          }),
        }),
      );

      assert.match(failure.message, /completed final model response/u);
    }),
  );

  it.effect("recovers malformed local cursor state with a fresh Antigravity conversation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const recovered = yield* runDriverTurn({
        fixture,
        fakeMode: "fresh-recovery-success",
        turn: makeTurn({
          turnId: "turn-invalid-cursor",
          externalSession: new DurableExternalSession({
            driverResumeCursor: makeDriverResumeCursor("not-json"),
          }),
        }),
      });

      assert.deepStrictEqual(recovered.events, [] satisfies readonly AgentRuntimeEvent[]);
      assert.deepStrictEqual(recovered.result.lostSessionRecovery, {
        reason: "antigravity-invalid-resume-cursor",
        diagnostics: {
          previousCursor: "not-json",
          message: "Malformed Antigravity driver resume cursor.",
        },
      });
      assert.strictEqual(
        yield* durableConversationId(recovered.result),
        fakeAgyFixture.recoveredConversationId,
      );

      const invocations = yield* readFakeInvocations({
        invocationLogPath: fixture.invocationLogPath,
      });
      const invocation = invocations.at(0);
      assert.ok(invocation, "missing recovery invocation");
      assert.strictEqual(invocation.prompt, lostSessionRecoveryDriverPrompt);
      assert.strictEqual(invocation.args.includes("--conversation"), false);
    }),
  );

  it.effect("recovers Antigravity resume rejection with a fresh conversation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* runDriverTurn({
        fixture,
        fakeMode: "success",
        turn: makeTurn({ turnId: "turn-rejected-resume-seed" }),
      });
      const recovered = yield* runDriverTurn({
        fixture,
        fakeMode: "resume-rejected",
        turn: makeTurn({
          turnId: "turn-rejected-resume-followup",
          externalSession: durableSessionFromResult(first.result),
        }),
      });

      assert.deepStrictEqual(recovered.events, [] satisfies readonly AgentRuntimeEvent[]);
      assert.deepStrictEqual(recovered.result.lostSessionRecovery, {
        reason: "antigravity-resume-failed",
        diagnostics: {
          previousCursor: fakeAgyFixture.conversationId,
          message: "Antigravity CLI exited with code 31.",
        },
      });
      assert.strictEqual(
        yield* durableConversationId(recovered.result),
        fakeAgyFixture.recoveredConversationId,
      );

      const invocations = yield* readFakeInvocations({
        invocationLogPath: fixture.invocationLogPath,
      });
      const failedResume = invocations.at(1);
      const freshRecovery = invocations.at(2);
      assert.ok(failedResume, "missing failed resume invocation");
      assert.ok(freshRecovery, "missing fresh recovery invocation");
      assert.strictEqual(
        argValue(failedResume.args, "--conversation"),
        fakeAgyFixture.conversationId,
      );
      assert.strictEqual(freshRecovery.prompt, lostSessionRecoveryDriverPrompt);
      assert.strictEqual(freshRecovery.args.includes("--conversation"), false);
    }),
  );

  it.effect("fails when a malformed cursor cannot be replaced by a fresh conversation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const failure = yield* Effect.flip(
        runDriverTurn({
          fixture,
          fakeMode: "fresh-recovery-failure",
          turn: makeTurn({
            turnId: "turn-invalid-cursor-unrecoverable",
            externalSession: new DurableExternalSession({
              driverResumeCursor: makeDriverResumeCursor("not-json"),
            }),
          }),
        }),
      );

      assert.match(
        failure.message,
        /could not preserve Antigravity CLI session continuity or start a fresh external session/u,
      );
    }),
  );
});
