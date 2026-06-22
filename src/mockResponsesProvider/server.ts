import { Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { decodeCodexTurnRequest } from "./codexTurnContext.ts";
import { InvalidResponsesRequest } from "./errors.ts";
import { InputLogger } from "./inputLogger.ts";
import {
  createResponsesRequestDiagnostics,
  RequestDiagnosticsLogger,
} from "./requestDiagnosticsLogger.ts";
import { createMockResponseEvents } from "./responseEvents.ts";
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

  yield* logger.logInput(responsesRequest.responses.input);

  return HttpServerResponse.stream(
    encodeSseStream(createMockResponseEvents({ request: responsesRequest.responses })),
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
    Effect.catchTag("InvalidResponsesRequest", (error) =>
      Effect.succeed(invalidResponsesRequestResponse(error)),
    ),
  ),
);

/** Scoped server layer that serves the mock Responses router on the current HTTP server. */
export const mockResponsesServerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const httpApp = yield* HttpRouter.toHttpEffect(mockResponsesRoutesLayer);
    yield* HttpServer.serveEffect(httpApp);
  }),
);
