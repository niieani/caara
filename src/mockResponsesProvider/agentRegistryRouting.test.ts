import { randomUUID } from "node:crypto";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Match, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  AgentDriverRegistry,
  type AgentDriver,
  type AgentDriverResolve,
  type AgentRuntimeEvent,
  createRuntimeTurnSucceededEvent,
  unsupportedExternalAgentKindError,
} from "./agentDriver.ts";
import { InputLogger } from "./inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { EphemeralExternalSession } from "./sessionDirectory.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { simulatorAgentDriver, simulatorAgentDriverRegistryLive } from "./simulatorDriver.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Stable project root used as a realistic Codex workspace path in registry routing tests. */
const projectRoot = process.cwd();

/** Stable Codex turn id used by registry routing fixtures. */
const makeTurnId = (): string => "turn-registry-routing-1";

/** Builds Codex turn metadata for registry routing tests. */
const makeTurnMetadata = (): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-registry-routing",
  session_id: "parent-session-registry-routing",
  thread_id: "codex-thread-registry-routing",
  turn_id: makeTurnId(),
  window_id: "window-registry-routing",
  request_kind: "turn",
  parent_thread_id: "parent-thread-registry-routing",
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

/** Builds complete Codex request headers for one registry routing request. */
const makeCodexHeaders = (): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-registry-routing",
  "thread-id": "codex-thread-registry-routing",
  "x-client-request-id": makeTurnId(),
  "x-codex-parent-thread-id": "parent-thread-registry-routing",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(makeTurnMetadata()),
  "x-codex-window-id": "window-registry-routing",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Codex-style request body using a non-Claude kind for registry routing assertions. */
const geminiRequestBody = {
  model: "gemini/pro",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "registry route this" }],
    },
  ],
  stream: true,
  tools: [],
  tool_choice: "auto",
  store: false,
  client_metadata: {
    thread_id: "codex-thread-registry-routing",
    turn_id: makeTurnId(),
  },
  metadata: {
    cwd: projectRoot,
  },
} as const satisfies Schema.Json;

/** Applies stable Codex headers to one outgoing test request. */
const setCodexHeaders = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  let nextRequest = request;
  for (const [name, value] of Object.entries(makeCodexHeaders())) {
    nextRequest = nextRequest.pipe(HttpClientRequest.setHeader(name, value));
  }
  return nextRequest;
};

/** Builds a per-test logger layer that records logged inputs in insertion order. */
const makeCaptureLoggerLayer = (loggedInputs: Array<Schema.Json>) =>
  Layer.succeed(InputLogger, {
    logInput: Effect.fnUntraced(function* (input: Schema.Json) {
      yield* Effect.sync(() => {
        loggedInputs.push(input);
      });
    }),
  });

/** Builds a per-test diagnostics logger layer that records request diagnostics in order. */
const makeCaptureDiagnosticsLoggerLayer = (loggedDiagnostics: Array<ResponsesRequestDiagnostics>) =>
  Layer.succeed(RequestDiagnosticsLogger, {
    logRequest: Effect.fnUntraced(function* (diagnostics: ResponsesRequestDiagnostics) {
      yield* Effect.sync(() => {
        loggedDiagnostics.push(diagnostics);
      });
    }),
  });

/** Builds a per-test relay logger layer that records structured relay events in order. */
const makeCaptureRelayLoggerLayer = (relayEvents: Array<RelayLogEvent>) =>
  Layer.succeed(RelayLogger, {
    log: Effect.fnUntraced(function* (event: RelayLogEvent) {
      yield* Effect.sync(() => {
        relayEvents.push(event);
      });
    }),
  });

/** Registry routing test layer dependencies that vary per test invocation. */
interface RegistryRoutingLayerOptions {
  readonly loggedInputs: Array<Schema.Json>;
  readonly loggedDiagnostics: Array<ResponsesRequestDiagnostics>;
  readonly relayEvents: Array<RelayLogEvent>;
  readonly driverRegistryLayer?: typeof simulatorAgentDriverRegistryLive;
}

/** Builds the full scoped provider test layer for registry routing assertions. */
const makeRegistryRoutingTestLayer = ({
  loggedInputs,
  loggedDiagnostics,
  relayEvents,
  driverRegistryLayer = simulatorAgentDriverRegistryLive,
}: RegistryRoutingLayerOptions) => {
  const stateDir = path.join(projectRoot, "temp.local", `registry-routing-${randomUUID()}`);
  return mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(makeCaptureLoggerLayer(loggedInputs)),
    Layer.provideMerge(makeCaptureDiagnosticsLoggerLayer(loggedDiagnostics)),
    Layer.provideMerge(makeCaptureRelayLoggerLayer(relayEvents)),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(driverRegistryLayer),
  );
};

/** Builds a registry layer that supports exactly one external agent kind. */
const singleKindAgentDriverRegistryLayer = ({
  externalAgentKind,
  driver,
}: {
  readonly externalAgentKind: string;
  readonly driver: AgentDriver;
}) => {
  const resolve: AgentDriverResolve = Effect.fnUntraced(function* (target) {
    return yield* Match.value(target.externalAgentKind).pipe(
      Match.when(externalAgentKind, () => Effect.succeed(driver)),
      Match.orElse((kind) =>
        Effect.fail(unsupportedExternalAgentKindError({ externalAgentKind: kind })),
      ),
    );
  });

  return Layer.succeed(AgentDriverRegistry, { resolve });
};

/** Decodes OpenAI Responses SSE frames from the real response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Returns true when a value is a non-array object record. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads an object field after asserting that the parent is a record. */
const getField = (value: unknown, field: string): unknown => {
  assert.ok(isRecord(value), "value must be an object record");
  return value[field];
};

/** Extracts normalized runtime lifecycle tags from captured relay events. */
const runtimeEventTags = (events: readonly RelayLogEvent[]): readonly string[] =>
  events
    .filter((event) => event._tag === "RuntimeEventRelayed")
    .map((event) => event.runtimeEventTag);

/** Runtime permission-denial fixture used to prove relay context. */
const permissionDeniedRuntimeEvents = [
  {
    _tag: "PermissionDenied",
    toolName: "Bash",
    toolUseId: "toolu_registry_permission",
    message: "Caara denied this permission request.",
    decisionReason: "dontAsk denied unapproved tool",
  },
  createRuntimeTurnSucceededEvent(),
] satisfies readonly AgentRuntimeEvent[];

/** Decodes and validates the terminal response completion event shape. */
const decodeCompletedEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("response.completed"),
  }),
);

/** Test program proving supported agent kinds come from the injected registry, not decoding. */
function routesExternalAgentKindThroughDriverRegistry() {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];
  const driverRegistryLayer = singleKindAgentDriverRegistryLayer({
    externalAgentKind: "gemini",
    driver: simulatorAgentDriver,
  });

  return Effect.gen(function* () {
    const request = setCodexHeaders(
      yield* HttpClientRequest.bodyJson(HttpClientRequest.post("/v1/responses"), geminiRequestBody),
    );
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    const lastFrame = frames.at(-1);
    assert.ok(lastFrame, "SSE stream must include at least one frame");
    const completedData = decodeCompletedEvent(lastFrame.data);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(completedData.type, "response.completed");
    assert.deepStrictEqual(loggedInputs, [geminiRequestBody.input]);
    assert.strictEqual(loggedDiagnostics.length, 1);
    assert.deepStrictEqual(
      relayEvents.slice(0, 4).map((event) => event._tag),
      ["TurnAccepted", "TargetSelected", "TurnInFlightAcquired", "DriverStarted"],
    );
    assert.deepStrictEqual(runtimeEventTags(relayEvents), [
      "ItemCreated",
      "ContentStarted",
      "ContentDelta",
      "ContentCompleted",
      "ItemCompleted",
      "ItemCreated",
      "ContentStarted",
      "ContentDelta",
      "ContentCompleted",
      "ItemCompleted",
      "TurnSucceeded",
    ]);
    assert.strictEqual(relayEvents.at(-1)?._tag, "TurnCompleted");
    assert.deepStrictEqual(relayEvents[1], {
      _tag: "TargetSelected",
      externalAgentKind: "gemini",
      externalModelSpecifier: "pro",
      rawDriverOptions: {},
      requestedModel: "gemini/pro",
      threadId: "codex-thread-registry-routing",
      turnId: makeTurnId(),
    });
  }).pipe(
    Effect.provide(
      makeRegistryRoutingTestLayer({
        loggedInputs,
        loggedDiagnostics,
        relayEvents,
        driverRegistryLayer,
      }),
    ),
  );
}

/** Test program proving permission-denied runtime events carry relay-log context. */
function relaysPermissionDeniedRuntimeContext() {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];
  const driverRegistryLayer = singleKindAgentDriverRegistryLayer({
    externalAgentKind: "gemini",
    driver: {
      startOrResumeTurn: () =>
        Effect.succeed({
          runtimeEvents: Stream.fromIterable(permissionDeniedRuntimeEvents),
          externalSession: new EphemeralExternalSession({}),
          cancel: Effect.succeed({ _tag: "Interrupted", sessionReusable: true }),
        }),
    },
  });

  return Effect.gen(function* () {
    const request = setCodexHeaders(
      yield* HttpClientRequest.bodyJson(HttpClientRequest.post("/v1/responses"), geminiRequestBody),
    );
    const response = yield* HttpClient.execute(request);
    const frames = yield* decodeResponseSseFrames(response.stream);
    const lastFrame = frames.at(-1);
    assert.ok(lastFrame, "permission-denied response must include terminal SSE frame");
    const completedData = decodeCompletedEvent(lastFrame.data);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(completedData.type, "response.completed");
    assert.deepStrictEqual(runtimeEventTags(relayEvents), ["PermissionDenied", "TurnSucceeded"]);
    assert.deepStrictEqual(
      relayEvents.filter((event) => event._tag === "PermissionDenied"),
      [
        {
          _tag: "PermissionDenied",
          threadId: "codex-thread-registry-routing",
          turnId: makeTurnId(),
          toolName: "Bash",
          toolUseId: "toolu_registry_permission",
          message: "Caara denied this permission request.",
          decisionReason: "dontAsk denied unapproved tool",
        },
      ],
    );
  }).pipe(
    Effect.provide(
      makeRegistryRoutingTestLayer({
        loggedInputs,
        loggedDiagnostics,
        relayEvents,
        driverRegistryLayer,
      }),
    ),
  );
}

/** Test program proving unsupported agent kind failure comes from registry resolution. */
function rejectsUnsupportedAgentKindThroughDriverRegistry() {
  const loggedInputs: Array<Schema.Json> = [];
  const loggedDiagnostics: Array<ResponsesRequestDiagnostics> = [];
  const relayEvents: Array<RelayLogEvent> = [];

  return Effect.gen(function* () {
    const request = setCodexHeaders(
      yield* HttpClientRequest.bodyJson(HttpClientRequest.post("/v1/responses"), geminiRequestBody),
    );
    const response = yield* HttpClient.execute(request);
    const responseBody = yield* response.json;

    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(loggedInputs, []);
    assert.strictEqual(getField(getField(responseBody, "error"), "type"), "server_error");
    assert.match(
      String(getField(getField(responseBody, "error"), "message")),
      /unsupported external agent kind/i,
    );
    assert.strictEqual(loggedDiagnostics.length, 1);
    assert.deepStrictEqual(
      relayEvents.map((event) => event._tag),
      ["TurnAccepted", "TargetSelected"],
    );
  }).pipe(
    Effect.provide(makeRegistryRoutingTestLayer({ loggedInputs, loggedDiagnostics, relayEvents })),
  );
}

describe("agent registry routing", () => {
  it.effect(
    "routes supported external agent kinds through the injected driver registry",
    routesExternalAgentKindThroughDriverRegistry,
  );

  it.effect(
    "relays permission-denied runtime events with tool context",
    relaysPermissionDeniedRuntimeContext,
  );

  it.effect(
    "rejects unsupported external agent kinds through registry resolution",
    rejectsUnsupportedAgentKindThroughDriverRegistry,
  );
});
