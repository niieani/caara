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
const makeTurnId = (): string => "turn-real-claude-first";

/** Text prompt expected to cross the Responses-to-Claude prompt boundary. */
const makePromptText = (): string => "please prove first turn";

/** Assistant text emitted by the fake Claude executable. */
const makeFakeAssistantText = (): string => "FAKE_CLAUDE_FIRST_TURN";

/** Responses input fixture sent through the Claude driver boundary. */
const makeInput = (): Schema.Json => [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: makePromptText() }],
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

writeFileSync(process.env.CAARA_FAKE_CLAUDE_ARGV_FILE, JSON.stringify(args));
writeFileSync(process.env.CAARA_FAKE_CLAUDE_CWD_FILE, process.cwd());
writeFileSync(process.env.CAARA_FAKE_CLAUDE_PROMPT_FILE, args.at(-1) ?? "");

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
    content: [{ type: "text", text: "${makeFakeAssistantText()}" }],
  },
  session_id: sessionId,
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "${makeFakeAssistantText()}",
  stop_reason: "end_turn",
  session_id: sessionId,
  terminal_reason: "completed",
}));
`;

/** Builds Codex turn metadata for the first-turn Claude driver test. */
const makeTurnMetadata = (): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: makeThreadId(),
  turn_id: makeTurnId(),
  window_id: "window-1",
  request_kind: "turn",
  parent_thread_id: "parent-thread-1",
  subagent_kind: "caara",
  sandbox: "workspace-write",
  workspaces: {
    [projectRoot]: {
      latest_git_commit_hash: "abcdef0",
      has_changes: true,
    },
  },
  turn_started_at_unix_ms: 1,
});

/** Builds Codex headers for the first-turn Claude driver test. */
const makeHeaders = (): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": makeThreadId(),
  "x-client-request-id": makeTurnId(),
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(makeTurnMetadata()),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for the fake Claude turn. */
const makeBody = (): Schema.Json => ({
  model: "claude/haiku",
  input: makeInput(),
  stream: true,
  client_metadata: {
    thread_id: makeThreadId(),
    turn_id: makeTurnId(),
  },
  metadata: {
    cwd: projectRoot,
  },
});

/** Applies the Codex header fixture to one outgoing request. */
const setHeaders = ({
  request,
}: {
  readonly request: HttpClientRequest.HttpClientRequest;
}): HttpClientRequest.HttpClientRequest => {
  let nextRequest = request;
  for (const [name, value] of Object.entries(makeHeaders())) {
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

/** Reads the argv fixture written by the fake Claude executable. */
const readArgvFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  const content = yield* readTextFile({ filePath });
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
    content,
  ).pipe(Effect.mapError((cause) => claudeCodeDriverTestError(cause)));
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
  it.effect("drives a first Claude Code turn and stores a durable session binding", () =>
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

      const request = setHeaders({
        request: yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post("/v1/responses?effort=low&max_budget_usd=0.02&tools=disabled"),
          makeBody(),
        ),
      });
      const response = yield* HttpClient.execute(request).pipe(
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
      const frames = yield* decodeResponseSseFrames(response.stream);
      const argv = yield* readArgvFile({ filePath: argvFile });
      const cwd = yield* readTextFile({ filePath: cwdFile });
      const prompt = yield* readTextFile({ filePath: promptFile });
      const binding = yield* readPersistedBinding({ stateDir });
      const sessionIdIndex = argv.indexOf("--session-id") + 1;
      const sessionId = argv.at(sessionIdIndex);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(assistantTextFromFrames(frames), makeFakeAssistantText());
      assert.strictEqual(cwd, projectRoot);
      assert.strictEqual(prompt, makePromptText());
      assert.ok(sessionId, "driver must generate --session-id for first turns");
      assert.deepStrictEqual(argv, [
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
        makePromptText(),
      ]);
      const durableSession = yield* Schema.decodeUnknownEffect(DurableExternalSession)(
        binding.externalSession,
      ).pipe(Effect.mapError((cause) => claudeCodeDriverTestError(cause)));
      assert.strictEqual(durableSession.externalSessionId, sessionId);
      assert.strictEqual(binding.cwd, projectRoot);
      assert.strictEqual(binding.requestedModel, "claude/haiku");
      assert.strictEqual(binding.externalModelSpecifier, "haiku");
      assert.deepStrictEqual(binding.rawDriverOptions, {
        effort: "low",
        max_budget_usd: "0.02",
        tools: "disabled",
      });
      assert.deepStrictEqual(inputs, [makeInput()]);
      assert.strictEqual(diagnostics.length, 1);
      assert.deepStrictEqual(
        relayEvents.map((event) => event._tag),
        [
          "TurnAccepted",
          "TargetSelected",
          "TurnInFlightAcquired",
          "DriverStarted",
          "RuntimeEventRelayed",
          "TurnCompleted",
        ],
      );
    }),
  );
});
