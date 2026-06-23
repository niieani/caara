import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import * as OpenAiSchema from "@effect/ai-openai/OpenAiSchema";
import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { InputLogger } from "./inputLogger.ts";
import { RelayLogger, type RelayLogEvent } from "./relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  type ResponsesRequestDiagnostics,
} from "./requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { simulatorAgentDriverRegistryLive } from "./simulatorDriver.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Test fixture failure for concurrency setup and response inspection. */
class TurnConcurrencyTestError extends Schema.TaggedErrorClass<TurnConcurrencyTestError>()(
  "TurnConcurrencyTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown fixture failures into a tagged test error. */
const turnConcurrencyTestError = (cause: unknown): TurnConcurrencyTestError =>
  new TurnConcurrencyTestError({ message: String(cause) });

/** Project root used as the Codex workspace path in concurrency tests. */
const projectRoot = process.cwd();

/** Stable ids used by the overlapping-turn concurrency scenario. */
const concurrencyScenarioIds = {
  sameThread: "codex-thread-overlap",
  otherThread: "codex-thread-independent",
  heldTurn: "turn-held-1",
  overlappingTurn: "turn-overlap-2",
  independentTurn: "turn-independent-1",
} as const;

/** Builds Codex turn metadata for one concurrency test request. */
const makeTurnMetadata = ({
  threadId,
  turnId,
}: {
  readonly threadId: string;
  readonly turnId: string;
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
  workspaces: {
    [projectRoot]: {
      latest_git_commit_hash: "abcdef0",
      has_changes: true,
    },
  },
  turn_started_at_unix_ms: 1,
});

/** Builds Codex headers for one concurrency test request. */
const makeHeaders = ({
  threadId,
  turnId,
}: {
  readonly threadId: string;
  readonly turnId: string;
}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": threadId,
  "x-client-request-id": turnId,
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(
    makeTurnMetadata({ threadId, turnId }),
  ),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
});

/** Builds a Codex-shaped streaming body for one concurrency test request. */
const makeBody = ({
  threadId,
  turnId,
}: {
  readonly threadId: string;
  readonly turnId: string;
}): Schema.Json => ({
  model: "claude/test",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: turnId }],
    },
  ],
  stream: true,
  client_metadata: {
    thread_id: threadId,
    turn_id: turnId,
  },
  metadata: {
    cwd: projectRoot,
  },
});

/** Applies headers to one outgoing HTTP request. */
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

/** Reads an object field after asserting the parent is an object record. */
const getField = (value: unknown, field: string): unknown => {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value[field as keyof typeof value];
};

/** Decodes Responses SSE frames from a response byte stream. */
const decodeResponseSseFrames = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(OpenAiSchema.ResponseStreamEvent)),
    Stream.runCollect,
    Effect.map((frames) => [...frames]),
  );

/** Builds the shared provider layer for one concurrency scenario. */
const providerLayer = ({
  stateDir,
  relayEvents,
  heldTurnStarted,
}: {
  readonly stateDir: string;
  readonly relayEvents: Array<RelayLogEvent>;
  readonly heldTurnStarted: Deferred.Deferred<void>;
}) =>
  mockResponsesServerLayer.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(
      Layer.succeed(InputLogger, {
        logInput: Effect.fnUntraced(function* () {
          yield* Effect.void;
        }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(RequestDiagnosticsLogger, {
        logRequest: Effect.fnUntraced(function* (_entry: ResponsesRequestDiagnostics) {
          yield* Effect.void;
        }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(RelayLogger, {
        log: Effect.fnUntraced(function* (event: RelayLogEvent) {
          yield* Effect.sync(() => relayEvents.push(event));
          const heldStartEvent = Option.fromUndefinedOr(
            [event]
              .filter(
                (entry) => entry._tag === "TurnInFlightAcquired" && entry.turnId === "turn-held-1",
              )
              .at(0),
          );
          yield* Option.match(heldStartEvent, {
            onNone: () => Effect.void,
            onSome: () => Deferred.succeed(heldTurnStarted, undefined),
          });
        }),
      }),
    ),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir })),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(simulatorAgentDriverRegistryLive),
  );

/** Builds a POST /v1/responses request for one turn. */
const makeRequest = Effect.fnUntraced(function* ({
  threadId,
  turnId,
  url,
}: {
  readonly threadId: string;
  readonly turnId: string;
  readonly url: string;
}) {
  return setHeaders({
    request: yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(url),
      makeBody({ threadId, turnId }),
    ),
    headers: makeHeaders({ threadId, turnId }),
  });
});

/** Runs the request sequence after the shared server layer has been provided. */
const runProvidedConcurrencyRequests = Effect.fnUntraced(function* ({
  relayEvents,
  heldTurnStarted,
}: {
  readonly relayEvents: Array<RelayLogEvent>;
  readonly heldTurnStarted: Deferred.Deferred<void>;
}) {
  const heldRequest = yield* makeRequest({
    threadId: concurrencyScenarioIds.sameThread,
    turnId: concurrencyScenarioIds.heldTurn,
    url: "/v1/responses?simulator_hold=open",
  });
  const heldFiber = yield* HttpClient.execute(heldRequest).pipe(
    Effect.flatMap((response) => Stream.runDrain(response.stream)),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Deferred.await(heldTurnStarted);

  const overlappingRequest = yield* makeRequest({
    threadId: concurrencyScenarioIds.sameThread,
    turnId: concurrencyScenarioIds.overlappingTurn,
    url: "/v1/responses",
  });
  const overlappingResponse = yield* HttpClient.execute(overlappingRequest);
  const overlappingBody = yield* overlappingResponse.json;

  assert.strictEqual(overlappingResponse.status, 409);
  assert.strictEqual(getField(getField(overlappingBody, "error"), "type"), "server_error");
  assert.match(
    String(getField(getField(overlappingBody, "error"), "message")),
    /already has an in-flight turn/i,
  );

  const otherThreadRequest = yield* makeRequest({
    threadId: concurrencyScenarioIds.otherThread,
    turnId: concurrencyScenarioIds.independentTurn,
    url: "/v1/responses",
  });
  const otherThreadResponse = yield* HttpClient.execute(otherThreadRequest);
  const frames = yield* decodeResponseSseFrames(otherThreadResponse.stream);
  assert.strictEqual(otherThreadResponse.status, 200);
  assert.ok(frames.some((frame) => frame.event === "response.completed"));
  assert.deepStrictEqual(
    relayEvents.filter((event) => event._tag === "TurnConcurrencyConflict"),
    [
      {
        _tag: "TurnConcurrencyConflict",
        externalAgentKind: "claude",
        codexThreadId: concurrencyScenarioIds.sameThread,
        incomingTurnId: concurrencyScenarioIds.overlappingTurn,
        runningTurnId: concurrencyScenarioIds.heldTurn,
      },
    ],
  );
  assert.strictEqual(
    relayEvents.filter(
      (event) =>
        event._tag === "DriverStarted" && event.turnId === concurrencyScenarioIds.overlappingTurn,
    ).length,
    0,
  );
  yield* Fiber.interrupt(heldFiber);
});

/** Runs the overlapping-turn scenario under one shared provider layer. */
const runConcurrencyScenario = Effect.fnUntraced(function* ({
  stateDir,
}: {
  readonly stateDir: string;
}) {
  const relayEvents: Array<RelayLogEvent> = [];
  const heldTurnStarted = yield* Deferred.make<void>();
  const layer = providerLayer({ stateDir, relayEvents, heldTurnStarted });

  yield* runProvidedConcurrencyRequests({ relayEvents, heldTurnStarted }).pipe(
    Effect.provide(layer),
    Effect.scoped,
  );
});

describe("turn concurrency guard", () => {
  it.effect("rejects overlapping turns for the same binding without blocking other threads", () =>
    Effect.gen(function* () {
      const tempRoot = path.join(projectRoot, "temp.local");
      yield* Effect.tryPromise({
        try: () => fs.mkdir(tempRoot, { recursive: true }),
        catch: turnConcurrencyTestError,
      });
      const stateDir = yield* Effect.tryPromise({
        try: () => fs.mkdtemp(path.join(tempRoot, `turn-concurrency-${randomUUID()}-`)),
        catch: turnConcurrencyTestError,
      });
      yield* runConcurrencyScenario({ stateDir });
    }),
  );
});
