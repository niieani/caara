import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "../mockResponsesProvider/inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "../mockResponsesProvider/relayLogger.ts";
import { RequestDiagnosticsLogger } from "../mockResponsesProvider/requestDiagnosticsLogger.ts";
import { assistantTextFromResponseFrames } from "../mockResponsesProvider/responseFrameTestHelpers.ts";
import { mockResponsesServerLayer } from "../mockResponsesProvider/server.ts";
import { CaaraSessionBinding } from "../mockResponsesProvider/sessionDirectory.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { sessionBindingFilePath } from "../mockResponsesProvider/sessionDirectoryPlatform.ts";
import { lostSessionRecoveryAssistantText } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { claudeCodeAgentDriverRegistryLive } from "./driver.ts";

/** Policy test failure for fake Claude process setup and artifact inspection. */
export class ClaudeCodePolicyTestError extends Schema.TaggedErrorClass<ClaudeCodePolicyTestError>()(
  "ClaudeCodePolicyTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown policy test failures into a tagged error. */
export const policyTestError = (cause: unknown): ClaudeCodePolicyTestError =>
  new ClaudeCodePolicyTestError({ message: String(cause) });

/** Project root used as the Codex workspace path in Claude policy tests. */
const projectRoot = process.cwd();

/** Fake Claude harness state shared by one policy test. */
export interface ClaudeCodePolicyHarness {
  readonly stateDir: string;
  readonly argvFile: string;
  readonly signalFile: string;
  readonly relayEvents: Array<RelayLogEvent>;
  readonly heldTurnStarted: Deferred.Deferred<void>;
  readonly layer: ReturnType<typeof providerLayer>;
}

/** Builds a Codex request body containing one input_text prompt. */
const makeBody = ({
  prompt,
  includeCwd,
}: {
  readonly prompt: string;
  readonly includeCwd: boolean;
}): Schema.Json => ({
  model: "claude/haiku",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  ],
  stream: true,
  metadata: Object.fromEntries([projectRoot].filter(() => includeCwd).map((cwd) => ["cwd", cwd])),
});

/** Builds Codex turn metadata for one policy test request. */
const makeTurnMetadata = ({
  threadId,
  turnId,
  includeWorkspace,
}: {
  readonly threadId: string;
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: threadId,
  turn_id: turnId,
  window_id: "window-1",
  request_kind: "turn",
  parent_thread_id: "parent-thread-1",
  subagent_kind: "caara",
  sandbox: "workspace-write",
  workspaces: Object.fromEntries(
    [projectRoot]
      .filter(() => includeWorkspace)
      .map((workspacePath) => [
        workspacePath,
        {
          latest_git_commit_hash: "abcdef0",
          has_changes: true,
        },
      ]),
  ),
  turn_started_at_unix_ms: 1,
});

/** Builds Codex headers for one policy test request. */
const makeHeaders = ({
  threadId,
  turnId,
  includeWorkspace,
}: {
  readonly threadId: string;
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": threadId,
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ threadId, turnId, includeWorkspace }),
  ),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Applies Codex headers to one outgoing policy test request. */
const setHeaders = ({
  request,
  headers,
}: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly headers: Readonly<Record<string, string>>;
}): HttpClientRequest.HttpClientRequest => {
  let nextRequest = request;
  for (const [name, value] of Object.entries(headers)) {
    nextRequest = nextRequest.pipe(HttpClientRequest.setHeader(name, value));
  }
  return nextRequest;
};

/** Decodes Responses SSE frames from one response stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Builds the fake Claude executable used by policy tests. */
const writeFakeClaudeExecutable = Effect.fnUntraced(function* ({
  testDir,
}: {
  readonly testDir: string;
}) {
  const fakeClaudePath = path.join(testDir, "claude");
  const source = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args.at(index + 1);
};
const sessionId = valueAfter("--session-id") ?? valueAfter("--resume") ?? "missing-session";
const model = valueAfter("--model") ?? "missing-model";
const prompt = args.at(-1) ?? "";
const isResume = valueAfter("--resume") !== undefined;
const isRecovery = prompt.includes("${lostSessionRecoveryAssistantText}");
const assistantText = isRecovery ? "${lostSessionRecoveryAssistantText}" : isResume ? "FAKE_AFTER_RESUME" : "FAKE_FIRST_TURN";
const append = (name, value) => appendFileSync(process.env[name], value + "\\n", { flag: "a" });
const emit = (value) => console.log(JSON.stringify(value));

append("CAARA_FAKE_CLAUDE_ARGV_FILE", JSON.stringify(args));
append("CAARA_FAKE_CLAUDE_CWD_FILE", process.cwd());
append("CAARA_FAKE_CLAUDE_PROMPT_FILE", prompt);

if (isResume && process.env.CAARA_FAKE_CLAUDE_RESUME_FAIL === "1") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: null, session_id: sessionId, terminal_reason: "completed", errors: ["No conversation found with session ID: " + sessionId] });
  process.exit(1);
}

if (isRecovery && process.env.CAARA_FAKE_CLAUDE_FRESH_FAIL === "1") {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "fresh start failed", stop_reason: null, session_id: sessionId, terminal_reason: "completed" });
  process.exit(1);
}

emit({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: [], model, permissionMode: "default", claude_code_version: "fake-policy" });

if (prompt.includes("hold for cancellation")) {
  emit({ type: "assistant", message: { content: [{ type: "text", text: "FAKE_HOLD_STARTED" }] }, session_id: sessionId });
  process.on("SIGINT", () => {
    append("CAARA_FAKE_CLAUDE_SIGNAL_FILE", "SIGINT");
    emit({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] }, session_id: sessionId });
    emit({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: null, session_id: sessionId, terminal_reason: "aborted_streaming", errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"] });
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  emit({ type: "assistant", message: { content: [{ type: "text", text: assistantText }] }, session_id: sessionId });
  emit({ type: "result", subtype: "success", is_error: false, result: assistantText, stop_reason: "end_turn", session_id: sessionId, terminal_reason: "completed" });
}
`;
  yield* Effect.tryPromise({
    try: () => fs.writeFile(fakeClaudePath, source, { mode: 0o755 }),
    catch: policyTestError,
  });
  return fakeClaudePath;
});

/** Creates a fresh policy state directory under project-local temp.local. */
const makeStateDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: policyTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `claude-code-policy-${randomUUID()}-`)),
    catch: policyTestError,
  });
});

/** Builds a fresh provider layer for one fake Claude policy scenario. */
const providerLayer = ({
  stateDir,
  fakeClaudePath,
  fakeEnv,
  relayEvents,
  heldTurnStarted,
  heldTurnId,
}: {
  readonly stateDir: string;
  readonly fakeClaudePath: string;
  readonly fakeEnv: NodeJS.ProcessEnv;
  readonly relayEvents: Array<RelayLogEvent>;
  readonly heldTurnStarted: Deferred.Deferred<void>;
  readonly heldTurnId: string;
}) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(Layer.succeed(InputLogger, { logInput: () => Effect.void })),
    Layer.provideMerge(Layer.succeed(RequestDiagnosticsLogger, { logRequest: () => Effect.void })),
    Layer.provideMerge(
      Layer.succeed(RelayLogger, {
        log: Effect.fnUntraced(function* (event: RelayLogEvent) {
          yield* Effect.sync(() => relayEvents.push(event));
          const heldRuntimeEvent = Option.fromUndefinedOr(
            [event]
              .filter(
                (entry) => entry._tag === "RuntimeEventRelayed" && entry.turnId === heldTurnId,
              )
              .at(0),
          );
          yield* Option.match(heldRuntimeEvent, {
            onNone: () => Effect.void,
            onSome: () => Deferred.succeed(heldTurnStarted, undefined),
          });
        }),
      }),
    ),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(
      claudeCodeAgentDriverRegistryLive({ command: fakeClaudePath, env: fakeEnv }),
    ),
  );

/** Creates a fake Claude policy harness with isolated process artifacts. */
export const makePolicyHarness = Effect.fnUntraced(function* ({
  heldTurnId,
  extraEnv = {},
}: {
  readonly heldTurnId: string;
  readonly extraEnv?: NodeJS.ProcessEnv;
}) {
  const testDir = yield* makeStateDir();
  const stateDir = path.join(testDir, "state");
  const fakeClaudePath = yield* writeFakeClaudeExecutable({ testDir });
  const argvFile = path.join(testDir, "argv.jsonl");
  const signalFile = path.join(testDir, "signals.log");
  const relayEvents: Array<RelayLogEvent> = [];
  const heldTurnStarted = yield* Deferred.make<void>();
  const layer = providerLayer({
    stateDir,
    fakeClaudePath,
    fakeEnv: {
      ...process.env,
      CAARA_FAKE_CLAUDE_ARGV_FILE: argvFile,
      CAARA_FAKE_CLAUDE_CWD_FILE: path.join(testDir, "cwd.log"),
      CAARA_FAKE_CLAUDE_PROMPT_FILE: path.join(testDir, "prompt.log"),
      CAARA_FAKE_CLAUDE_SIGNAL_FILE: signalFile,
      ...extraEnv,
    },
    relayEvents,
    heldTurnStarted,
    heldTurnId,
  });
  return { stateDir, argvFile, signalFile, relayEvents, heldTurnStarted, layer };
});

/** Builds one policy test request. */
const makeRequest = Effect.fnUntraced(function* ({
  threadId,
  turnId,
  prompt,
  includeWorkspace,
  includeCwd,
}: {
  readonly threadId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly includeWorkspace: boolean;
  readonly includeCwd: boolean;
}) {
  return setHeaders({
    request: yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post("/v1/responses"),
      makeBody({ prompt, includeCwd }),
    ),
    headers: makeHeaders({ threadId, turnId, includeWorkspace }),
  });
});

/** Reads fake Claude argv JSONL records. */
export const readArgvLog = Effect.fnUntraced(function* ({
  filePath,
}: {
  readonly filePath: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: policyTestError,
  });
  return yield* Effect.forEach(
    content.split("\n").filter((line) => line.trim().length > 0),
    (line) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(line).pipe(
        Effect.mapError((cause) => policyTestError(cause)),
      ),
  );
});

/** Reads a text artifact from the fake Claude policy harness. */
export const readTextFile = Effect.fnUntraced(function* ({
  filePath,
}: {
  readonly filePath: string;
}) {
  return yield* Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: policyTestError,
  });
});

/** Reads the persisted binding for one fake Claude policy thread. */
export const readPersistedBinding = Effect.fnUntraced(function* ({
  stateDir,
  threadId,
}: {
  readonly stateDir: string;
  readonly threadId: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () =>
      fs.readFile(
        sessionBindingFilePath({
          stateDir,
          externalAgentKind: "claude",
          driverInstanceId: "claude",
          codexThreadId: threadId,
        }),
        "utf8",
      ),
    catch: policyTestError,
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(CaaraSessionBinding))(content).pipe(
    Effect.mapError((cause) => policyTestError(cause)),
  );
});

/** Extracts a JSON object field while keeping response-error assertions type-safe. */
export const getField = (value: unknown, field: string): unknown => {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value[field as keyof typeof value];
};

/** Runs one completed fake Claude turn and returns the assistant text. */
export const runCompletedTurn = Effect.fnUntraced(function* ({
  harness,
  threadId,
  turnId,
  prompt,
  includeWorkspace,
  includeCwd,
}: {
  readonly harness: ClaudeCodePolicyHarness;
  readonly threadId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly includeWorkspace: boolean;
  readonly includeCwd: boolean;
}) {
  const request = yield* makeRequest({ threadId, turnId, prompt, includeWorkspace, includeCwd });
  const response = yield* HttpClient.execute(request).pipe(Effect.provide(harness.layer));
  const frames = yield* decodeResponseSseFrames(response.stream);
  assert.strictEqual(response.status, 200);
  return assistantTextFromResponseFrames(frames);
});

/** Runs one fake Claude turn that is expected to fail before streaming starts. */
export const runErrorTurn = Effect.fnUntraced(function* ({
  harness,
  threadId,
  turnId,
  prompt,
}: {
  readonly harness: ClaudeCodePolicyHarness;
  readonly threadId: string;
  readonly turnId: string;
  readonly prompt: string;
}) {
  const request = yield* makeRequest({
    threadId,
    turnId,
    prompt,
    includeWorkspace: false,
    includeCwd: false,
  });
  const response = yield* HttpClient.execute(request).pipe(Effect.provide(harness.layer));
  return {
    status: response.status,
    body: yield* response.json,
  };
});

/** Runs a held fake Claude turn and interrupts the client response stream. */
export const runDisconnectedTurn = Effect.fnUntraced(function* ({
  harness,
  threadId,
  turnId,
  prompt,
}: {
  readonly harness: ClaudeCodePolicyHarness;
  readonly threadId: string;
  readonly turnId: string;
  readonly prompt: string;
}) {
  const request = yield* makeRequest({
    threadId,
    turnId,
    prompt,
    includeWorkspace: true,
    includeCwd: true,
  });
  yield* Effect.gen(function* () {
    const fiber = yield* HttpClient.execute(request).pipe(
      Effect.flatMap((response) => Stream.runDrain(response.stream)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.await(harness.heldTurnStarted);
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(harness.layer), Effect.scoped);
});
