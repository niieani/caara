import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "./inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionBindingFilePath, sessionDirectoryLive } from "./sessionDirectory.ts";
import { simulatorAgentDriverRegistryLive, simulatorDriverFixture } from "./simulatorDriver.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Test fixture failure for filesystem setup and persisted binding inspection. */
class SessionBindingTestError extends Schema.TaggedErrorClass<SessionBindingTestError>()(
  "SessionBindingTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged test error. */
const sessionBindingTestError = (cause: unknown): SessionBindingTestError =>
  new SessionBindingTestError({ message: String(cause) });

/** Project root used as the Codex workspace path in session binding tests. */
const projectRoot = process.cwd();

/** Stable Codex thread id used to prove binding reuse across turns. */
const makeThreadId = (): string => "codex-thread-session-binding";

/** Builds Codex turn metadata for a simulator session test turn. */
const makeTurnMetadata = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: makeThreadId(),
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

/** Builds Codex headers for one simulator session test turn. */
const makeHeaders = ({
  turnId,
  includeWorkspace,
}: {
  readonly turnId: string;
  readonly includeWorkspace: boolean;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": makeThreadId(),
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ turnId, includeWorkspace }),
  ),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming Responses request body for one turn. */
const makeBody = ({
  model,
  turnId,
  includeCwd,
}: {
  readonly model: string;
  readonly turnId: string;
  readonly includeCwd: boolean;
}): Schema.Json => ({
  model,
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `turn ${turnId}` }],
    },
  ],
  stream: true,
  client_metadata: {
    thread_id: makeThreadId(),
    turn_id: turnId,
  },
  metadata: Object.fromEntries([projectRoot].filter(() => includeCwd).map((cwd) => ["cwd", cwd])),
});

/** Applies the Codex header fixture to a test HTTP request. */
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

/** Builds a fresh server layer backed by one shared session state directory. */
const providerLayer = ({
  stateDir,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
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
    Layer.provideMerge(simulatorAgentDriverRegistryLive),
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

/** Runs one HTTP turn through a fresh provider layer that shares one state directory. */
const runTurn = ({
  stateDir,
  turnId,
  model,
  url,
  includeWorkspace,
  includeCwd,
  inputs,
  diagnostics,
  relayEvents,
}: {
  readonly stateDir: string;
  readonly turnId: string;
  readonly model: string;
  readonly url: string;
  readonly includeWorkspace: boolean;
  readonly includeCwd: boolean;
  readonly inputs: Array<Schema.Json>;
  readonly diagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
}) =>
  Effect.gen(function* () {
    const request = setHeaders({
      request: yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(url),
        makeBody({ model, turnId, includeCwd }),
      ),
      headers: makeHeaders({ turnId, includeWorkspace }),
    });
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    assert.strictEqual(response.status, 200);
    return assistantTextFromFrames(frames);
  }).pipe(Effect.provide(providerLayer({ stateDir, inputs, diagnostics, relayEvents })));

/** Reads the persisted binding JSON for the test's Claude/thread session key. */
const readPersistedBinding = ({ stateDir }: { readonly stateDir: string }) =>
  Effect.tryPromise({
    try: () =>
      fs.readFile(
        sessionBindingFilePath({
          stateDir,
          externalAgentKind: "claude",
          codexThreadId: makeThreadId(),
        }),
        "utf8",
      ),
    catch: sessionBindingTestError,
  }).pipe(Effect.map((content) => Schema.decodeSync(Schema.UnknownFromJsonString)(content)));

describe("session binding simulator integration", () => {
  it.effect("persists and reloads simulator bindings while passing previous target state", () =>
    Effect.gen(function* () {
      const tempRoot = path.join(projectRoot, "temp.local");
      yield* Effect.tryPromise({
        try: () => fs.mkdir(tempRoot, { recursive: true }),
        catch: sessionBindingTestError,
      });
      const stateDir = yield* Effect.tryPromise({
        try: () => fs.mkdtemp(path.join(tempRoot, `session-binding-${randomUUID()}-`)),
        catch: sessionBindingTestError,
      });
      const inputs: Array<Schema.Json> = [];
      const diagnostics: Array<ResponsesRequestDiagnostics> = [];
      const relayEvents: Array<RelayLogEvent> = [];

      const firstAssistantText = yield* runTurn({
        stateDir,
        turnId: "turn-session-1",
        model: "claude/test",
        url: "/v1/responses?effort=max",
        includeWorkspace: true,
        includeCwd: true,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(firstAssistantText, simulatorDriverFixture.assistantText);
      const firstBinding = yield* readPersistedBinding({ stateDir });
      assert.deepStrictEqual(firstBinding, {
        codexThreadId: makeThreadId(),
        parentCodexSessionId: "parent-session-1",
        externalAgentKind: "claude",
        requestedModel: "claude/test",
        externalModelSpecifier: "test",
        rawDriverOptions: { effort: "max" },
        externalSession: {
          _tag: "Durable",
          externalSessionId: simulatorDriverFixture.externalSessionId,
        },
        cwd: projectRoot,
        createdFromTurnId: "turn-session-1",
        lastTurnId: "turn-session-1",
      });

      const secondAssistantText = yield* runTurn({
        stateDir,
        turnId: "turn-session-2",
        model: "claude/sonnet",
        url: "/v1/responses?effort=low",
        includeWorkspace: false,
        includeCwd: false,
        inputs,
        diagnostics,
        relayEvents,
      });
      assert.strictEqual(secondAssistantText, simulatorDriverFixture.resumedAssistantText);
      const secondBinding = yield* readPersistedBinding({ stateDir });
      assert.deepStrictEqual(secondBinding, {
        codexThreadId: makeThreadId(),
        parentCodexSessionId: "parent-session-1",
        externalAgentKind: "claude",
        requestedModel: "claude/sonnet",
        externalModelSpecifier: "sonnet",
        rawDriverOptions: { effort: "low" },
        externalSession: {
          _tag: "Durable",
          externalSessionId: simulatorDriverFixture.externalSessionId,
        },
        cwd: projectRoot,
        createdFromTurnId: "turn-session-1",
        lastTurnId: "turn-session-2",
      });

      const secondDriverStart = relayEvents.filter(
        (event) => event._tag === "DriverStarted" && event.turnId === "turn-session-2",
      );
      assert.deepStrictEqual(secondDriverStart, [
        {
          _tag: "DriverStarted",
          threadId: makeThreadId(),
          turnId: "turn-session-2",
          externalAgentKind: "claude",
          externalSessionId: simulatorDriverFixture.externalSessionId,
          previousTarget: {
            requestedModel: "claude/test",
            externalAgentKind: "claude",
            externalModelSpecifier: "test",
            rawDriverOptions: { effort: "max" },
          },
        },
      ]);
      assert.strictEqual(inputs.length, 2);
      assert.strictEqual(diagnostics.length, 2);
    }),
  );
});
