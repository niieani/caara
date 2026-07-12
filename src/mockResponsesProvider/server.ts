import { Effect, Layer, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { portableAgentRoutesLayer } from "../portableAgentHttp.ts";
import type { AgentDriverError, AgentDriverTurnResult } from "./agentDriver.ts";
import { runAgentTurn } from "./agentTurn.ts";
import { agentTurnContextFromCodex } from "./codexAgentTurnContext.ts";
import { decodeCodexTurnRequest, type DecodedCodexTurnRequest } from "./codexTurnContext.ts";
import { normalizeCurrentTurnInput } from "./currentTurnInput.ts";
import { InvalidResponsesRequest } from "./errors.ts";
import { InputLogger } from "./inputLogger.ts";
import { RelayLogger } from "./relayLogger.ts";
import {
  createResponsesRequestDiagnostics,
  RequestDiagnosticsLogger,
} from "./requestDiagnosticsLogger.ts";
import { createResponseEventStreamFromRuntimeEvents } from "./responseEvents.ts";
import { EphemeralExternalSession } from "./sessionDirectory.ts";
import { encodeSseEventStream } from "./sse.ts";
import type { TurnConcurrencyConflict } from "./turnConcurrency.ts";

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

/** Builds a failed driver turn result for accepted start/query-construction failures. */
const failedDriverStartTurnResult = ({
  error,
}: {
  readonly error: AgentDriverError;
}): AgentDriverTurnResult => ({
  runtimeEvents: Stream.fromIterable([
    {
      _tag: "TurnFailed",
      error,
    },
  ]),
  externalSession: new EphemeralExternalSession({}),
  cancel: Effect.succeed({ _tag: "Terminated", sessionReusable: false }),
});

/** Failure raised after transport acceptance but before a driver turn can start. */
interface AcceptedPreDriverFailure {
  readonly _tag: "AcceptedPreDriverFailure";
  readonly responsesRequest: DecodedCodexTurnRequest;
  readonly error: AgentDriverError;
}

/** Builds the internal failure used to escape into the accepted SSE failure path. */
const acceptedPreDriverFailure = ({
  responsesRequest,
  error,
}: {
  readonly responsesRequest: DecodedCodexTurnRequest;
  readonly error: AgentDriverError;
}): AcceptedPreDriverFailure => ({
  _tag: "AcceptedPreDriverFailure",
  responsesRequest,
  error,
});

/** Streams an accepted pre-driver failure as a Codex-visible nonretryable Responses failure. */
const acceptedPreDriverFailureResponse = Effect.fnUntraced(function* ({
  responsesRequest,
  error,
}: AcceptedPreDriverFailure) {
  const relayLogger = yield* RelayLogger;
  yield* relayLogger.log({
    _tag: "TurnFailed",
    threadId: responsesRequest.codex.threadId,
    turnId: responsesRequest.codex.turnId,
    message: error.message,
  });
  const responseEventStream = createResponseEventStreamFromRuntimeEvents({
    request: responsesRequest.responses,
    runtimeEvents: failedDriverStartTurnResult({ error }).runtimeEvents,
    onRuntimeFailure: (runtimeError) =>
      relayLogger.log({
        _tag: "TurnFailed",
        threadId: responsesRequest.codex.threadId,
        turnId: responsesRequest.codex.turnId,
        message: runtimeError.message,
      }),
  });

  return HttpServerResponse.stream(encodeSseEventStream(responseEventStream), {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});

/** Converts an overlapping-turn conflict into an OpenAI-shaped JSON error response. */
export const turnConcurrencyConflictResponse = (error: TurnConcurrencyConflict) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        type: "server_error",
        message: error.message,
      },
    },
    { status: 409 },
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
    requireCwd: false,
  });
});

/** Handles `POST /v1/responses` for the mock provider. */
export const handleResponsesCreate = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const responsesRequest = yield* readResponsesCreateRequest(request);
  const logger = yield* InputLogger;
  const relayLogger = yield* RelayLogger;

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

  const normalizedPrompt = yield* normalizeCurrentTurnInput({
    input: responsesRequest.responses.input,
  }).pipe(
    Effect.catchTag("AgentDriverError", (error) =>
      Effect.fail(acceptedPreDriverFailure({ responsesRequest, error })),
    ),
  );
  const agentTurn = yield* runAgentTurn({
    target: responsesRequest.target,
    prompt: normalizedPrompt,
    ...agentTurnContextFromCodex({ codex: responsesRequest.codex }),
  }).pipe(
    Effect.catchTags({
      AgentDriverError: (error) =>
        Effect.fail(acceptedPreDriverFailure({ responsesRequest, error })),
      TurnConcurrencyConflict: (error) =>
        Effect.gen(function* () {
          yield* relayLogger.log({
            _tag: "TurnConcurrencyConflict",
            externalAgentKind: error.externalAgentKind,
            codexThreadId: error.codexThreadId,
            incomingTurnId: error.incomingTurnId,
            runningTurnId: error.runningTurnId,
          });
          return yield* error;
        }),
    }),
  );
  yield* logger.logInput(responsesRequest.responses.input);
  const responseEventStream = createResponseEventStreamFromRuntimeEvents({
    request: responsesRequest.responses,
    runtimeEvents: agentTurn.runtimeEvents,
    onRuntimeFailure: (error) =>
      relayLogger.log({
        _tag: "TurnFailed",
        threadId: responsesRequest.codex.threadId,
        turnId: responsesRequest.codex.turnId,
        message: error.message,
      }),
  });

  return HttpServerResponse.stream(encodeSseEventStream(responseEventStream), {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});

/** Shallow Caara health response body. */
export const caaraHealthResponseBody = {
  status: "ok",
  service: "caara",
} as const;

/** Handles `GET /health` for shallow router health checks. */
export const handleHealth = HttpServerResponse.jsonUnsafe(caaraHealthResponseBody);

/** HTTP route layer for the Caara health endpoint. */
export const caaraHealthRouteLayer = HttpRouter.add("GET", "/health", handleHealth);

/** HTTP route layer for the mock Responses provider. */
export const responsesCreateRouteLayer = HttpRouter.add("POST", "/v1/responses", (request) =>
  handleResponsesCreate(request).pipe(
    Effect.catchTags({
      InvalidResponsesRequest: (error: InvalidResponsesRequest) =>
        Effect.succeed(invalidResponsesRequestResponse(error)),
      AcceptedPreDriverFailure: acceptedPreDriverFailureResponse,
      TurnConcurrencyConflict: (error: TurnConcurrencyConflict) =>
        Effect.succeed(turnConcurrencyConflictResponse(error)),
    }),
  ),
);

/** HTTP route layer for Caara's full Responses-compatible router. */
export const mockResponsesRoutesLayer = Layer.mergeAll(
  caaraHealthRouteLayer,
  responsesCreateRouteLayer,
  portableAgentRoutesLayer,
);

/** Scoped server layer that serves the mock Responses router on the current HTTP server. */
export const mockResponsesServerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const httpApp = yield* HttpRouter.toHttpEffect(mockResponsesRoutesLayer);
    yield* HttpServer.serveEffect(httpApp);
  }),
);
