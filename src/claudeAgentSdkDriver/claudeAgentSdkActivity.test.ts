import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import type { NonNullableUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import {
  collectPromptMessages,
  fakeSdkHarness,
  sdkTextDelta,
} from "./claudeAgentSdkDriverTestHarness.ts";

/** Project root used as the Codex workspace path in SDK activity tests. */
const projectRoot = process.cwd();

/** Returns the stable Claude SDK session id used by fake activity runs. */
const sdkSessionId = (): string => "00000000-0000-4000-8000-00000000a101";

/** Stable Codex thread id used to isolate SDK activity bindings. */
const makeThreadId = (): string => "codex-thread-claude-sdk-activity";

/** Builds the minimal non-null SDK usage payload required by assistant messages. */
const sdkUsage = (): NonNullableUsage => ({
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  inference_geo: "",
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  output_tokens_details: {
    thinking_tokens: 0,
  },
  server_tool_use: {
    web_fetch_requests: 0,
    web_search_requests: 0,
  },
  service_tier: "standard",
  speed: "standard",
});

/** Test fixture failure for SDK activity provider setup. */
class ClaudeAgentSdkActivityTestError extends Schema.TaggedErrorClass<ClaudeAgentSdkActivityTestError>()(
  "ClaudeAgentSdkActivityTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged SDK activity test error. */
const claudeAgentSdkActivityTestError = (cause: unknown): ClaudeAgentSdkActivityTestError =>
  new ClaudeAgentSdkActivityTestError({ message: String(cause) });

/** Builds one fake SDK assistant message containing a Read tool_use block. */
const sdkReadToolUse = (): SDKMessage =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_sdk_activity_tool_use",
      type: "message",
      container: null,
      context_management: null,
      diagnostics: null,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_read_server",
          name: "Read",
          input: { file_path: "src/server.ts" },
        },
      ],
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: sdkUsage(),
    },
    uuid: "00000000-0000-4000-8000-00000000a201",
    session_id: sdkSessionId(),
  }) satisfies SDKMessage;

/** Builds one fake SDK user message containing a completed tool_result block. */
const sdkReadToolResult = (): SDKMessage =>
  ({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_read_server",
          content: "raw file contents must not be relayed",
        },
      ],
    },
    tool_use_result: "raw file contents must not be relayed",
    uuid: "00000000-0000-4000-8000-00000000a202",
    session_id: sdkSessionId(),
  }) satisfies SDKMessage;

/** Builds one fake SDK task-started message. */
const sdkTaskStarted = (): SDKMessage =>
  ({
    type: "system",
    subtype: "task_started",
    task_id: "task_activity_review",
    tool_use_id: "toolu_task_review",
    description: "inspect runtime events",
    subagent_type: "general-purpose",
    uuid: "00000000-0000-4000-8000-00000000a203",
    session_id: sdkSessionId(),
  }) satisfies SDKMessage;

/** Builds one fake SDK task-progress message. */
const sdkTaskProgress = (): SDKMessage =>
  ({
    type: "system",
    subtype: "task_progress",
    task_id: "task_activity_review",
    tool_use_id: "toolu_task_review",
    description: "inspect runtime events",
    subagent_type: "general-purpose",
    usage: {
      total_tokens: 123,
      tool_uses: 2,
      duration_ms: 3000,
    },
    last_tool_name: "Read",
    summary: "Inspecting runtime events",
    uuid: "00000000-0000-4000-8000-00000000a204",
    session_id: sdkSessionId(),
  }) satisfies SDKMessage;

/** Builds Codex turn metadata for one SDK activity provider request. */
const makeTurnMetadata = (turnId: string): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-claude-sdk-activity",
  session_id: "parent-session-claude-sdk-activity",
  thread_id: makeThreadId(),
  turn_id: turnId,
  window_id: "window-claude-sdk-activity",
  request_kind: "turn",
  parent_thread_id: "parent-thread-claude-sdk-activity",
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

/** Builds complete Codex headers for one SDK activity provider request. */
const makeHeaders = (turnId: string): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-claude-sdk-activity",
  "thread-id": makeThreadId(),
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-claude-sdk-activity",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata(turnId),
  ),
  "x-codex-window-id": "window-claude-sdk-activity",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for Claude SDK activity. */
const makeBody = ({
  turnId,
  input = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `activity ${turnId}` }],
    },
  ],
}: {
  readonly turnId: string;
  readonly input?: Schema.Json;
}): Schema.Json => ({
  model: "claude/sonnet",
  input,
  stream: true,
  client_metadata: {
    thread_id: makeThreadId(),
    turn_id: turnId,
  },
  metadata: { cwd: projectRoot },
});

/** Builds the developer message that Codex Desktop sends before workspace user context. */
const developerMessage = (): Schema.Json => ({
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "Use Codex developer instructions." }],
});

/** Builds the AGENTS/environment prelude user message observed in real Codex subagent input. */
const codexPreludeMessage = (): Schema.Json => ({
  type: "message",
  role: "user",
  content: [
    {
      type: "input_text",
      text: "# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>\nUse Bun.\n</INSTRUCTIONS>",
    },
    {
      type: "input_text",
      text: "<environment_context>\n  <cwd>/workspace/project</cwd>\n</environment_context>",
    },
  ],
});

/** Builds one current managing-agent user request message. */
const currentUserMessage = (text: string): Schema.Json => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

/** Applies Codex identity headers to one outgoing test request. */
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

/** Builds the fake SDK runtime message sequence used by activity tests. */
const sdkActivityMessages = (): readonly SDKMessage[] => [
  sdkReadToolUse(),
  sdkTaskStarted(),
  sdkTaskProgress(),
  sdkReadToolResult(),
  sdkTextDelta({ sessionId: sdkSessionId(), text: "SDK final answer" }),
];

/** Builds a fresh provider harness backed by one fake Claude SDK runtime. */
const providerHarness = ({
  stateDir,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) => {
  const harness = fakeSdkHarness({
    sessionIds: [sdkSessionId()],
    runtimeMessages: [sdkActivityMessages()],
  });
  return {
    ...harness,
    layer: mockResponsesServerLayer.pipe(
      Layer.provideMerge(BunHttpServer.layerTest),
      Layer.provideMerge(inputLoggerLayer(inputs)),
      Layer.provideMerge(diagnosticsLoggerLayer(diagnostics)),
      Layer.provideMerge(relayLoggerLayer(relayEvents)),
      Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
      Layer.provideMerge(turnConcurrencyLive),
      Layer.provideMerge(harness.layer),
    ),
  };
};

/** Decodes raw Responses SSE frame data without dropping extension fields such as phase. */
const decodeUnknownResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Creates a fresh state directory under project-local temp.local. */
const makeStateDir = Effect.fnUntraced(function* () {
  const tempRoot = path.join(projectRoot, "temp.local");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(tempRoot, { recursive: true }),
    catch: claudeAgentSdkActivityTestError,
  });
  return yield* Effect.tryPromise({
    try: () => fs.mkdtemp(path.join(tempRoot, `claude-sdk-activity-${randomUUID()}-`)),
    catch: claudeAgentSdkActivityTestError,
  });
});

/** Runs one Claude SDK activity turn through the provider boundary. */
const runClaudeSdkActivityTurn = ({
  stateDir,
  turnId,
  url,
  input,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly url: string;
  readonly input?: Schema.Json;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) => {
  const harness = providerHarness({ stateDir, inputs, diagnostics, relayEvents });
  return Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(url),
        makeBody({ turnId, input }),
      ),
      headers: makeHeaders(turnId),
    });
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeUnknownResponseSseFrames(response.stream);
    assert.strictEqual(response.status, 200);
    return {
      frames,
      recordedRequests: harness.recordedRequests,
    };
  }).pipe(Effect.provide(harness.layer));
};

/** Schema used to extract assistant message completion items from raw SSE data. */
const AssistantMessageDoneData = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Struct({
    type: Schema.Literal("message"),
    phase: Schema.optional(
      Schema.Union([Schema.Literal("commentary"), Schema.Literal("final_answer")]),
    ),
    content: Schema.Array(
      Schema.Struct({
        type: Schema.Literal("output_text"),
        text: Schema.String,
      }),
    ),
  }),
});

/** Assistant message done data decoded from a raw Responses SSE frame. */
type AssistantMessageDoneData = typeof AssistantMessageDoneData.Type;

/** Returns completed assistant message items from raw decoded SSE frames. */
const assistantMessageDoneData = (
  frames: readonly { readonly data: unknown }[],
): readonly AssistantMessageDoneData[] =>
  frames.map((frame) => frame.data).filter(Schema.is(AssistantMessageDoneData));

/** Extracts the first text content from a completed assistant message item. */
const messageText = (message: AssistantMessageDoneData): string => {
  const content = message.item.content.at(0);
  assert.ok(content, "missing assistant content");
  return content.text;
};

/** Returns all decoded SSE event names in order. */
const eventNames = (frames: readonly { readonly event: string }[]): readonly string[] =>
  frames.map((frame) => frame.event);

/** Returns runtime event tags recorded by the relay logger. */
const runtimeEventTags = (events: readonly RelayLogEvent[]): readonly string[] =>
  events
    .filter((event) => event._tag === "RuntimeEventRelayed")
    .map((event) => event.runtimeEventTag);

describe("Claude Agent SDK activity commentary", () => {
  it.effect("maps SDK tool and task progress messages to commentary and relay records", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const result = yield* runClaudeSdkActivityTurn({
        stateDir,
        turnId: "turn-claude-sdk-activity-default",
        url: "/v1/responses",
        inputs,
        diagnostics,
        relayEvents,
      });
      const messages = assistantMessageDoneData(result.frames);

      assert.deepStrictEqual(
        messages.map((message) => [message.item.phase, messageText(message)]),
        [
          ["commentary", "Reading src/server.ts"],
          ["commentary", "Starting task: inspect runtime events"],
          ["commentary", "Inspecting runtime events"],
          ["commentary", "Read completed"],
          ["final_answer", "SDK final answer"],
        ],
      );
      assert.strictEqual(
        eventNames(result.frames).includes("response.function_call_arguments.delta"),
        false,
      );
      assert.strictEqual(
        eventNames(result.frames).includes("response.custom_tool_call_input.delta"),
        false,
      );
      assert.strictEqual(
        messages.some((message) => messageText(message).includes("raw file")),
        false,
      );
      assert.strictEqual(
        runtimeEventTags(relayEvents).filter((tag) => tag === "ItemCreated").length,
        5,
      );
      assert.strictEqual(inputs.length, 1);
      assert.strictEqual(diagnostics.length, 1);
    }),
  );

  it.effect("passes only normalized current-turn text to the SDK for real Codex input", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const result = yield* runClaudeSdkActivityTurn({
        stateDir,
        turnId: "turn-claude-sdk-codex-prelude",
        url: "/v1/responses",
        input: [
          developerMessage(),
          codexPreludeMessage(),
          currentUserMessage("Read README.md line 5."),
        ],
        inputs,
        diagnostics,
        relayEvents,
      });
      const request = result.recordedRequests.at(0);
      assert.ok(request, "missing SDK query request");
      const promptMessages = yield* collectPromptMessages(request.prompt);

      assert.deepStrictEqual(promptMessages, [
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "text", text: "Read README.md line 5." }],
          },
        },
      ]);
      const promptText = Schema.encodeSync(Schema.UnknownFromJsonString)(promptMessages);
      assert.strictEqual(promptText.includes("Use Codex developer instructions"), false);
      assert.strictEqual(promptText.includes("AGENTS.md instructions"), false);
      assert.strictEqual(promptText.includes("<environment_context>"), false);
      assert.deepStrictEqual(inputs, [
        [developerMessage(), codexPreludeMessage(), currentUserMessage("Read README.md line 5.")],
      ]);
      assert.deepStrictEqual(
        relayEvents.slice(0, 4).map((event) => event._tag),
        ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted"],
      );
    }),
  );

  it.effect("hides SDK activity commentary when activity is disabled but keeps relay records", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const result = yield* runClaudeSdkActivityTurn({
        stateDir,
        turnId: "turn-claude-sdk-activity-off",
        url: "/v1/responses?activity=off",
        inputs,
        diagnostics,
        relayEvents,
      });
      const messages = assistantMessageDoneData(result.frames);

      assert.deepStrictEqual(
        messages.map((message) => [message.item.phase, messageText(message)]),
        [["final_answer", "SDK final answer"]],
      );
      assert.strictEqual(
        runtimeEventTags(relayEvents).filter((tag) => tag === "ItemCreated").length,
        5,
      );
      assert.strictEqual(inputs.length, 1);
      assert.strictEqual(diagnostics.length, 1);
    }),
  );
});
