import { Effect, Layer, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { type AgentDriverError, AgentDriverRegistry } from "./agentDriver.ts";
import { decodeCodexTurnRequest } from "./codexTurnContext.ts";
import { InvalidResponsesRequest } from "./errors.ts";
import { InputLogger } from "./inputLogger.ts";
import { RelayLogger } from "./relayLogger.ts";
import {
  createResponsesRequestDiagnostics,
  RequestDiagnosticsLogger,
} from "./requestDiagnosticsLogger.ts";
import { createResponseEventsFromRuntimeEvents } from "./responseEvents.ts";
import { encodeSseStream } from "./sse.ts";

/** Converts a validation failure into an OpenAI-shaped JSON error response. */
export const invalidResponsesRequestResponse = (error: InvalidResponsesRequest) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        type: "invalid_request_error",
        message: error.message,
      },
    },
    { status: 400 },
  );

/** Converts a driver failure into an OpenAI-shaped JSON transport error response. */
export const driverErrorResponse = (error: AgentDriverError) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        type: "server_error",
        message: error.message,
      },
    },
    { status: 500 },
  );

/** Reads and validates a Codex-shaped streaming Responses request body. */
export const readResponsesCreateRequest = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const body = yield* request.json.pipe(
    Effect.mapError(
      () =>
        new InvalidResponsesRequest({
          message: "Request body must be valid JSON.",
        }),
    ),
  );

  const diagnosticsLogger = yield* RequestDiagnosticsLogger;
  yield* diagnosticsLogger.logRequest(createResponsesRequestDiagnostics({ request, body }));

  return yield* decodeCodexTurnRequest({
    headers: request.headers,
    url: request.url,
    body,
    requireCwd: true,
  });
});

/** Handles `POST /v1/responses` for the mock provider. */
export const handleResponsesCreate = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const responsesRequest = yield* readResponsesCreateRequest(request);
  const logger = yield* InputLogger;
  const relayLogger = yield* RelayLogger;
  const driverRegistry = yield* AgentDriverRegistry;

  yield* relayLogger.log({
    _tag: "TurnAccepted",
    threadId: responsesRequest.codex.threadId,
    turnId: responsesRequest.codex.turnId,
  });
  yield* relayLogger.log({
    _tag: "TargetSelected",
    threadId: responsesRequest.codex.threadId,
    turnId: responsesRequest.codex.turnId,
    requestedModel: responsesRequest.target.requestedModel,
    externalAgentKind: responsesRequest.target.externalAgentKind,
    externalModelSpecifier: responsesRequest.target.externalModelSpecifier,
    rawDriverOptions: responsesRequest.target.rawDriverOptions,
  });

  const driver = yield* driverRegistry.resolve(responsesRequest.target);
  yield* relayLogger.log({
    _tag: "DriverStarted",
    threadId: responsesRequest.codex.threadId,
    turnId: responsesRequest.codex.turnId,
    externalAgentKind: responsesRequest.target.externalAgentKind,
  });
  const runtimeEventStream = yield* driver
    .startOrResumeTurn({
      codex: responsesRequest.codex,
      target: responsesRequest.target,
      prompt: {
        input: responsesRequest.responses.input,
      },
    })
    .pipe(
      Effect.catchTag("AgentDriverError", (error) =>
        Effect.gen(function* () {
          yield* relayLogger.log({
            _tag: "TurnFailed",
            threadId: responsesRequest.codex.threadId,
            turnId: responsesRequest.codex.turnId,
            message: error.message,
          });
          return yield* error;
        }),
      ),
    );
  yield* logger.logInput(responsesRequest.responses.input);
  const runtimeEvents = [...(yield* Stream.runCollect(runtimeEventStream))];
  yield* Effect.forEach(runtimeEvents, (runtimeEvent) =>
    relayLogger.log({
      _tag: "RuntimeEventRelayed",
      threadId: responsesRequest.codex.threadId,
      turnId: responsesRequest.codex.turnId,
      runtimeEventTag: runtimeEvent._tag,
    }),
  );
  yield* relayLogger.log({
    _tag: "TurnCompleted",
    threadId: responsesRequest.codex.threadId,
    turnId: responsesRequest.codex.turnId,
  });

  return HttpServerResponse.stream(
    encodeSseStream(
      createResponseEventsFromRuntimeEvents({
        request: responsesRequest.responses,
        runtimeEvents,
      }),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    },
  );
});

/** HTTP route layer for the mock Responses provider. */
export const mockResponsesRoutesLayer = HttpRouter.add("POST", "/v1/responses", (request) =>
  handleResponsesCreate(request).pipe(
    Effect.catchTags({
      InvalidResponsesRequest: (error) => Effect.succeed(invalidResponsesRequestResponse(error)),
      AgentDriverError: (error) => Effect.succeed(driverErrorResponse(error)),
    }),
  ),
);

/** Scoped server layer that serves the mock Responses router on the current HTTP server. */
export const mockResponsesServerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const httpApp = yield* HttpRouter.toHttpEffect(mockResponsesRoutesLayer);
    yield* HttpServer.serveEffect(httpApp);
  }),
);
