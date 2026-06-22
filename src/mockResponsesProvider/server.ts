import { Effect, Exit, Layer, Option, Stream } from "effect";
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
import { createResponseEventStreamFromRuntimeEvents } from "./responseEvents.ts";
import {
  completeSessionBinding,
  deleteSessionBinding,
  prepareSessionBinding,
  SessionDirectory,
} from "./sessionDirectory.ts";
import { encodeSseEventStream } from "./sse.ts";
import { TurnConcurrency, type TurnConcurrencyConflict } from "./turnConcurrency.ts";

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
  const driverRegistry = yield* AgentDriverRegistry;
  const sessionDirectory = yield* SessionDirectory;
  const turnConcurrency = yield* TurnConcurrency;

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

  const preparedSession = yield* prepareSessionBinding({
    codex: responsesRequest.codex,
    target: responsesRequest.target,
  });
  const driver = yield* driverRegistry.resolve(responsesRequest.target);
  const lease = yield* turnConcurrency
    .acquire({
      key: {
        externalAgentKind: responsesRequest.target.externalAgentKind,
        codexThreadId: responsesRequest.codex.threadId,
      },
      turnId: responsesRequest.codex.turnId,
    })
    .pipe(
      Effect.catchTag("TurnConcurrencyConflict", (error) =>
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
      ),
    );
  yield* relayLogger.log({
    _tag: "TurnInFlightAcquired",
    externalAgentKind: responsesRequest.target.externalAgentKind,
    codexThreadId: responsesRequest.codex.threadId,
    turnId: responsesRequest.codex.turnId,
  });

  const previousTarget = Option.match(Option.fromUndefinedOr(preparedSession.previousTarget), {
    onNone: () => undefined,
    onSome: (target) => ({
      requestedModel: target.requestedModel,
      externalAgentKind: target.externalAgentKind,
      externalModelSpecifier: target.externalModelSpecifier,
      rawDriverOptions: target.rawDriverOptions,
    }),
  });
  const externalSessionId = Option.getOrUndefined(
    Option.fromUndefinedOr(
      [preparedSession.binding?.externalSession]
        .filter(
          (
            externalSession,
          ): externalSession is { readonly _tag: "Durable"; readonly externalSessionId: string } =>
            externalSession?._tag === "Durable",
        )
        .map((externalSession) => externalSession.externalSessionId)
        .at(0),
    ),
  );

  yield* relayLogger.log({
    _tag: "DriverStarted",
    threadId: responsesRequest.codex.threadId,
    turnId: responsesRequest.codex.turnId,
    externalAgentKind: responsesRequest.target.externalAgentKind,
    externalSessionId,
    previousTarget,
  });
  const driverTurnResult = yield* driver
    .startOrResumeTurn({
      codex: responsesRequest.codex,
      target: responsesRequest.target,
      prompt: {
        input: responsesRequest.responses.input,
      },
      cwd: preparedSession.cwd,
      previousTarget: preparedSession.previousTarget,
      externalSession: preparedSession.binding?.externalSession,
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
          yield* lease.release;
          return yield* error;
        }),
      ),
    );
  yield* logger.logInput(responsesRequest.responses.input);
  const runtimeEvents = driverTurnResult.runtimeEvents.pipe(
    Stream.tap((runtimeEvent) =>
      relayLogger.log({
        _tag: "RuntimeEventRelayed",
        threadId: responsesRequest.codex.threadId,
        turnId: responsesRequest.codex.turnId,
        runtimeEventTag: runtimeEvent._tag,
      }),
    ),
  );
  const completeTurn = Effect.gen(function* () {
    yield* relayLogger.log({
      _tag: "TurnCompleted",
      threadId: responsesRequest.codex.threadId,
      turnId: responsesRequest.codex.turnId,
    });
    yield* completeSessionBinding({
      codex: responsesRequest.codex,
      target: responsesRequest.target,
      prepared: preparedSession,
      externalSession: driverTurnResult.externalSession,
    }).pipe(Effect.provideService(SessionDirectory, sessionDirectory));
  }).pipe(Effect.ensuring(lease.release));
  const cancelTurn = Effect.gen(function* () {
    const cancellation = yield* driverTurnResult.cancel();
    yield* relayLogger.log({
      _tag: "TurnCancelled",
      externalAgentKind: responsesRequest.target.externalAgentKind,
      codexThreadId: responsesRequest.codex.threadId,
      turnId: responsesRequest.codex.turnId,
      outcomeTag: cancellation._tag,
      sessionReusable: cancellation.sessionReusable,
    });
    const reusableCancellation = Option.fromUndefinedOr(
      [cancellation].filter((outcome) => outcome.sessionReusable).at(0),
    );
    yield* Option.match(reusableCancellation, {
      onNone: () =>
        deleteSessionBinding({
          codex: responsesRequest.codex,
          target: responsesRequest.target,
        }).pipe(Effect.provideService(SessionDirectory, sessionDirectory)),
      onSome: () =>
        completeSessionBinding({
          codex: responsesRequest.codex,
          target: responsesRequest.target,
          prepared: preparedSession,
          externalSession: driverTurnResult.externalSession,
        }).pipe(Effect.provideService(SessionDirectory, sessionDirectory), Effect.asVoid),
    });
  }).pipe(Effect.ensuring(lease.release));
  /** Selects interrupted exits, which represent disconnected client streams. */
  const interruptedExitOption = (exit: Exit.Exit<unknown>): Option.Option<Exit.Exit<unknown>> =>
    Option.fromUndefinedOr([exit].filter(Exit.hasInterrupts).at(0));
  const releaseFailedTurn = lease.release;
  /** Finalizes a streamed turn according to normal completion, cancellation, or failure cleanup. */
  const finalizeTurn = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: () => completeTurn,
      onFailure: () =>
        Option.match(interruptedExitOption(exit), {
          onNone: () => releaseFailedTurn,
          onSome: () => cancelTurn,
        }),
    }).pipe(Effect.ignore({ log: true, message: "Failed while finalizing Caara turn stream." }));
  const responseEventStream = createResponseEventStreamFromRuntimeEvents({
    request: responsesRequest.responses,
    runtimeEvents,
  }).pipe(Stream.onExit(finalizeTurn));

  return HttpServerResponse.stream(encodeSseEventStream(responseEventStream), {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
});

/** HTTP route layer for the mock Responses provider. */
export const mockResponsesRoutesLayer = HttpRouter.add("POST", "/v1/responses", (request) =>
  handleResponsesCreate(request).pipe(
    Effect.catchTags({
      InvalidResponsesRequest: (error: InvalidResponsesRequest) =>
        Effect.succeed(invalidResponsesRequestResponse(error)),
      AgentDriverError: (error: AgentDriverError) => Effect.succeed(driverErrorResponse(error)),
      TurnConcurrencyConflict: (error: TurnConcurrencyConflict) =>
        Effect.succeed(turnConcurrencyConflictResponse(error)),
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
