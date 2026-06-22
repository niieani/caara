import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "../mockResponsesProvider/inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "../mockResponsesProvider/relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "../mockResponsesProvider/requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "../mockResponsesProvider/server.ts";
import {
  CaaraSessionBinding,
  DurableExternalSession,
  sessionBindingFilePath,
  sessionDirectoryLive,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { claudeCodeAgentDriverRegistryLive } from "./driver.ts";

/** Test fixture failure for fake Claude executable and persisted state inspection. */
class ClaudeCodeDriverTestError extends Schema.TaggedErrorClass<ClaudeCodeDriverTestError>()(
  "ClaudeCodeDriverTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged test error. */
const claudeCodeDriverTestError = (cause: unknown): ClaudeCodeDriverTestError =>
  new ClaudeCodeDriverTestError({ message: String(cause) });

/** Project root used as the resolved cwd for first-turn driver integration. */
const projectRoot = process.cwd();

/** Stable Codex thread id used by the real Claude driver first-turn test. */
const makeThreadId = (): string => "codex-thread-real-claude-first-turn";

/** Stable Codex turn id used by the real Claude driver first-turn test. */
const makeTurnId = (turnIndex: number): string => `turn-real-claude-${turnIndex}`;

/** Text prompt expected to cross the Responses-to-Claude prompt boundary. */
const makePromptText = (turnIndex: number): string => `please prove turn ${turnIndex}`;

/** Assistant text emitted by the fake Claude executable. */
const makeFakeAssistantText = (turnIndex: number): string => `FAKE_CLAUDE_TURN_${turnIndex}`;

/** Responses input fixture sent through the Claude driver boundary. */
const makeInput = (turnIndex: number): Schema.Json => [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: makePromptText(turnIndex) }],
  },
];

/** Script source for a fake `claude` executable that emits Claude Code stream-json. */
const fakeClaudeExecutableSource = (): string => `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args.at(index + 1) : undefined;
};
const sessionId = valueAfter("--session-id") ?? valueAfter("--resume") ?? "missing-session";
const model = valueAfter("--model") ?? "missing-model";
const turnIndex = valueAfter("--resume") === undefined ? 1 : 2;

writeFileSync(process.env.CAARA_FAKE_CLAUDE_ARGV_FILE, JSON.stringify(args) + "\\n", { flag: "a" });
writeFileSync(process.env.CAARA_FAKE_CLAUDE_CWD_FILE, process.cwd() + "\\n", { flag: "a" });
writeFileSync(process.env.CAARA_FAKE_CLAUDE_PROMPT_FILE, (args.at(-1) ?? "") + "\\n", { flag: "a" });

console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: sessionId,
  tools: [],
  model,
  permissionMode: "default",
  claude_code_version: "fake-claude-code",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: {
    content: [{ type: "text", text: \`FAKE_CLAUDE_TURN_\${turnIndex}\` }],
  },
  session_id: sessionId,
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: \`FAKE_CLAUDE_TURN_\${turnIndex}\`,
  stop_reason: "end_turn",
  session_id: sessionId,
  terminal_reason: "completed",
}));
`;

/** Builds Codex turn metadata for the first-turn Claude driver test. */
const makeTurnMetadata = ({
  turnIndex,
  includeWorkspace,
}: {
  readonly turnIndex: number;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: makeThreadId(),
  turn_id: makeTurnId(turnIndex),
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

/** Builds Codex headers for the first-turn Claude driver test. */
const makeHeaders = ({
  turnIndex,
  includeWorkspace,
}: {
  readonly turnIndex: number;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": makeThreadId(),
  "x-client-request-id": makeTurnId(turnIndex),
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ turnIndex, includeWorkspace }),
  ),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for the fake Claude turn. */
const makeBody = ({
  turnIndex,
  model,
  includeCwd,
}: {
  readonly turnIndex: number;
  readonly model: string;
  readonly includeCwd: boolean;
}): Schema.Json => ({
  model,
  input: makeInput(turnIndex),
  stream: true,
  client_metadata: {
    thread_id: makeThreadId(),
    turn_id: makeTurnId(turnIndex),
  },
  metadata: Object.fromEntries([projectRoot].filter(() => includeCwd).map((cwd) => ["cwd", cwd])),
});

/** Applies the Codex header fixture to one outgoing request. */
const setHeaders = ({
  request,
  turnIndex,
  includeWorkspace,
}: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly turnIndex: number;
  readonly includeWorkspace: boolean;
}): HttpClientRequest.HttpClientRequest => {
  let nextRequest = request;
  for (const [name, value] of Object.entries(makeHeaders({ turnIndex, includeWorkspace }))) {
    nextRequest = nextRequest.pipe(HttpClientRequest.setHeader(name, value));
  }
  return nextRequest;
};

/** Creates a fresh test directory under project-local temp.local. */
const makeTestDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: claudeCodeDriverTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `claude-code-driver-${randomUUID()}-`)),
    catch: claudeCodeDriverTestError,
  });
});

/** Writes the fake Claude executable and returns its absolute path. */
const writeFakeClaudeExecutable = Effect.fnUntraced(function* ({
  testDir,
}: {
  readonly testDir: string;
}) {
  const executablePath = path.join(testDir, "claude");
  yield* Effect.tryPromise({
    try: () => fs.writeFile(executablePath, fakeClaudeExecutableSource()),
    catch: claudeCodeDriverTestError,
  });
  yield* Effect.tryPromise({
    try: () => fs.chmod(executablePath, 0o755),
    catch: claudeCodeDriverTestError,
  });
  return executablePath;
});

/** Builds a capture logger layer for request inputs. */
const inputLoggerLayer = (inputs: Array<Schema.Json>) =>
  Layer.succeed(InputLogger, {
    logInput: Effect.fnUntraced(function* (input: Schema.Json) {
      yield* Effect.sync(() => inputs.push(input));
    }),
  });

/** Builds a capture logger layer for request diagnostics. */
const diagnosticsLoggerLayer = (diagnostics: Array<ResponsesRequestDiagnostics>) =>
  Layer.succeed(RequestDiagnosticsLogger, {
    logRequest: Effect.fnUntraced(function* (entry: ResponsesRequestDiagnostics) {
      yield* Effect.sync(() => diagnostics.push(entry));
    }),
  });

/** Builds a capture logger layer for relay events. */
const relayLoggerLayer = (events: Array<RelayLogEvent>) =>
  Layer.succeed(RelayLogger, {
    log: Effect.fnUntraced(function* (event: RelayLogEvent) {
      yield* Effect.sync(() => events.push(event));
    }),
  });

/** Builds the provider layer using the real Claude driver and fake executable. */
const providerLayer = ({
  stateDir,
  fakeClaudePath,
  fakeEnv,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly fakeClaudePath: string;
  readonly fakeEnv: Readonly<Record<string, string>>;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(inputLoggerLayer(inputs)),
    Layer.provideMerge(diagnosticsLoggerLayer(diagnostics)),
    Layer.provideMerge(relayLoggerLayer(relayEvents)),
    Layer.provideMerge(sessionDirectoryLive({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(
      claudeCodeAgentDriverRegistryLive({
        command: fakeClaudePath,
        env: fakeEnv,
      }),
    ),
  );

/** Decodes Responses SSE frames from a response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Extracts the completed assistant text from decoded Responses SSE frames. */
const assistantTextFromFrames = (
  frames: readonly {
    readonly event: string;
    readonly data: OpenAiSchema.ResponseStreamEvent;
  }[],
): string => {
  const messageDone = frames.find((frame) => frame.event === "response.output_item.done");
  assert.ok(messageDone, "missing assistant message done event");
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      item: Schema.Struct({
        content: Schema.Array(
          Schema.Struct({
            text: Schema.String,
          }),
        ),
      }),
    }),
  )(messageDone.data);
  const firstContent = decoded.item.content.at(0);
  assert.ok(firstContent, "missing assistant content");
  return firstContent.text;
};

/** Reads a UTF-8 fixture file written by the fake Claude executable. */
const readTextFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: claudeCodeDriverTestError,
  });
});

/** Reads the argv JSONL fixture written by the fake Claude executable. */
const readArgvLog = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  const content = yield* readTextFile({ filePath });
  return yield* Effect.forEach(
    content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    (line) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(line).pipe(
        Effect.mapError((cause) => claudeCodeDriverTestError(cause)),
      ),
  );
});

/** Reads the persisted Caara binding for the fake Claude turn. */
const readPersistedBinding = Effect.fnUntraced(function* ({
  stateDir,
}: {
  readonly stateDir: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () =>
      fs.readFile(
        sessionBindingFilePath({
          stateDir,
          externalAgentKind: "claude",
          codexThreadId: makeThreadId(),
        }),
        "utf8",
      ),
    catch: claudeCodeDriverTestError,
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(CaaraSessionBinding))(content).pipe(
    Effect.mapError((cause) => claudeCodeDriverTestError(cause)),
  );
});

describe("Claude Code driver integration", () => {
  it.effect("drives first and resumed Claude Code turns through one durable session", () =>
    Effect.gen(function* () {
      const testDir = yield* makeTestDir();
      const fakeClaudePath = yield* writeFakeClaudeExecutable({ testDir });
      const stateDir = path.join(testDir, "state");
      const argvFile = path.join(testDir, "argv.json");
      const cwdFile = path.join(testDir, "cwd.txt");
      const promptFile = path.join(testDir, "prompt.txt");
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];
      const fakeEnv = {
        ...process.env,
        CAARA_FAKE_CLAUDE_ARGV_FILE: argvFile,
        CAARA_FAKE_CLAUDE_CWD_FILE: cwdFile,
        CAARA_FAKE_CLAUDE_PROMPT_FILE: promptFile,
      };

      const firstRequest = setHeaders({
        request: yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post("/v1/responses?effort=low&max_budget_usd=0.02&tools=disabled"),
          makeBody({ turnIndex: 1, model: "claude/haiku", includeCwd: true }),
        ),
        turnIndex: 1,
        includeWorkspace: true,
      });
      const firstResponse = yield* HttpClient.execute(firstRequest).pipe(
        Effect.provide(
          providerLayer({
            stateDir,
            fakeClaudePath,
            fakeEnv,
            inputs,
            diagnostics,
            relayEvents,
          }),
        ),
      );
      const firstFrames = yield* decodeResponseSseFrames(firstResponse.stream);
      const firstArgv = (yield* readArgvLog({ filePath: argvFile })).at(0);
      assert.ok(firstArgv, "fake Claude must record first argv");
      const sessionIdIndex = firstArgv.indexOf("--session-id") + 1;
      const sessionId = firstArgv.at(sessionIdIndex);

      assert.strictEqual(firstResponse.status, 200);
      assert.strictEqual(assistantTextFromFrames(firstFrames), makeFakeAssistantText(1));
      assert.ok(sessionId, "driver must generate --session-id for first turns");
      assert.deepStrictEqual(firstArgv, [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--session-id",
        sessionId,
        "--model",
        "haiku",
        "--effort",
        "low",
        "--max-budget-usd",
        "0.02",
        "--tools",
        "",
        makePromptText(1),
      ]);

      const secondRequest = setHeaders({
        request: yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post("/v1/responses?effort=max&max_budget_usd=0.03&tools=default"),
          makeBody({ turnIndex: 2, model: "claude/sonnet", includeCwd: false }),
        ),
        turnIndex: 2,
        includeWorkspace: false,
      });
      const secondResponse = yield* HttpClient.execute(secondRequest).pipe(
        Effect.provide(
          providerLayer({
            stateDir,
            fakeClaudePath,
            fakeEnv,
            inputs,
            diagnostics,
            relayEvents,
          }),
        ),
      );
      const secondFrames = yield* decodeResponseSseFrames(secondResponse.stream);
      const argvLog = yield* readArgvLog({ filePath: argvFile });
      const secondArgv = argvLog.at(1);
      const cwdLog = (yield* readTextFile({ filePath: cwdFile })).trim().split("\n");
      const promptLog = (yield* readTextFile({ filePath: promptFile })).trim().split("\n");
      assert.ok(secondArgv, "fake Claude must record second argv");
      assert.strictEqual(secondResponse.status, 200);
      assert.strictEqual(assistantTextFromFrames(secondFrames), makeFakeAssistantText(2));
      assert.deepStrictEqual(secondArgv, [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--resume",
        sessionId,
        "--model",
        "sonnet",
        "--effort",
        "max",
        "--max-budget-usd",
        "0.03",
        "--tools",
        "default",
        makePromptText(2),
      ]);
      assert.deepStrictEqual(cwdLog, [projectRoot, projectRoot]);
      assert.deepStrictEqual(promptLog, [makePromptText(1), makePromptText(2)]);

      const binding = yield* readPersistedBinding({ stateDir });
      const durableSession = yield* Schema.decodeUnknownEffect(DurableExternalSession)(
        binding.externalSession,
      ).pipe(Effect.mapError((cause) => claudeCodeDriverTestError(cause)));
      assert.strictEqual(durableSession.externalSessionId, sessionId);
      assert.strictEqual(binding.cwd, projectRoot);
      assert.strictEqual(binding.requestedModel, "claude/sonnet");
      assert.strictEqual(binding.externalModelSpecifier, "sonnet");
      assert.deepStrictEqual(binding.rawDriverOptions, {
        effort: "max",
        max_budget_usd: "0.03",
        tools: "default",
      });
      assert.deepStrictEqual(inputs, [makeInput(1), makeInput(2)]);
      assert.strictEqual(diagnostics.length, 2);
      assert.strictEqual(relayEvents.filter((event) => event._tag === "TurnCompleted").length, 2);
    }),
  );
});
