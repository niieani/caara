import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Match, Option, Schema, Stream } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { caaraAgentContractVersion, type CaaraAgentErrorKind } from "./caaraAgentContract.ts";
import {
  AgentDriverRegistry,
  type AgentRuntimeEvent,
} from "./mockResponsesProvider/agentDriver.ts";
import { runAgentTurn } from "./mockResponsesProvider/agentTurn.ts";
import { AgentTarget } from "./mockResponsesProvider/codexTurnContext.ts";
import {
  sessionBindingKeyFromTurn,
  SessionDirectory,
} from "./mockResponsesProvider/sessionDirectory.ts";
import {
  ObservationCapability,
  PortableSessionId,
  PortableTurnId,
} from "./portableAgentIdentity.ts";
import { portableAgentStoreLive } from "./portableAgentStore.ts";
import {
  PortableAgentTurns,
  type PortableTurnObservation,
  portableAgentTurnsDurableLive,
} from "./portableAgentTurn.ts";

/** JSON request accepted by the portable diagnostic turn endpoint. */
export const PortableAgentStartRequest = Schema.Struct({
  prompt: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(1_048_576)),
  ),
  target: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]*\/.+$/u))),
  cwd: Schema.NonEmptyString,
  driverOptions: Schema.Record(Schema.String, Schema.String),
  originMetadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  sessionId: Schema.optional(PortableSessionId),
});

/** Service-internal response returned immediately after a portable turn is accepted. */
export const PortableAgentStartServiceResponse = Schema.Struct({
  turnId: PortableTurnId,
  sessionId: PortableSessionId,
  status: Schema.Literal("working"),
  observationPath: Schema.NonEmptyString,
});

/** Public CLI response with a trusted settings-derived absolute observation URL. */
export const PortableAgentStartResponse = Schema.Struct({
  turnId: PortableTurnId,
  sessionId: PortableSessionId,
  status: Schema.Literal("working"),
  observationUrl: Schema.NonEmptyString,
});

/** Agent-safe wait response containing no runtime observation fields. */
export const PortableAgentWaitResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("working"),
    turnId: PortableTurnId,
    sessionId: PortableSessionId,
    observationPath: Schema.NonEmptyString,
  }),
  Schema.Struct({ status: Schema.Literal("completed"), finalAnswer: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed") }),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    outcome: Schema.Literals(["Interrupted", "Abandoned", "Terminated"]),
    sessionReusable: Schema.Boolean,
  }),
]);

/** Agent-safe cancellation result containing no prior runtime activity. */
export const PortableAgentCancelResponse = Schema.Struct({
  status: Schema.Literal("cancelled"),
  outcome: Schema.Literals(["Interrupted", "Abandoned", "Terminated"]),
  sessionReusable: Schema.Boolean,
});

/** Maximum one-request wait duration accepted by the portable service. */
export const portableAgentWaitMaximumMillis = 30_000;

/** Explicit failure for a requested portable session without resumable durable state. */
export class PortableSessionUnavailable extends Schema.TaggedErrorClass<PortableSessionUnavailable>()(
  "PortableSessionUnavailable",
  { message: Schema.String },
) {}

/** Explicit validation failure raised before a portable turn is accepted. */
class PortableRequestValidationError extends Schema.TaggedErrorClass<PortableRequestValidationError>()(
  "PortableRequestValidationError",
  { message: Schema.String },
) {}

/** Escapes one runtime observation for literal placement in HTML text content. */
const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Renders a capability-authorized live human observation page. */
export const renderPortableObservationHtml = ({
  observation,
}: {
  readonly observation: PortableTurnObservation;
}): string => {
  const finalAnswerHtml = Option.match(Option.fromUndefinedOr(observation.finalAnswer), {
    onNone: () => "",
    onSome: (finalAnswer) => `<h2>Final answer</h2><pre>${escapeHtml(finalAnswer)}</pre>`,
  });
  const cancellationHtml = Option.match(Option.fromUndefinedOr(observation.cancellation), {
    onNone: () => "",
    onSome: ({ outcome, sessionReusable }) =>
      `<h2>Cancellation</h2><p>Outcome: ${outcome}</p><p>Session reusable: ${sessionReusable}</p>`,
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="1">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Caara turn</title>
<style>body{font:16px system-ui;max-width:72ch;margin:3rem auto;padding:0 1rem;color:#18181b}pre{white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:.5rem}</style></head>
<body><h1>Agent turn</h1><p>Status: ${observation.status}</p><h2>Activity</h2><pre>${escapeHtml(observation.activity)}</pre>${finalAnswerHtml}${cancellationHtml}</body></html>`;
};

/** Reads and validates one portable diagnostic start body. */
const readStartRequest = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const body = yield* request.json;
  return yield* Schema.decodeUnknownEffect(PortableAgentStartRequest)(body);
});

/** Splits one validated portable target into registry-owned components. */
const agentTargetFromPortableRequest = ({
  target,
  driverOptions,
}: {
  readonly target: string;
  readonly driverOptions: Readonly<Record<string, string>>;
}): AgentTarget => {
  const separator = target.indexOf("/");
  return new AgentTarget({
    requestedModel: target,
    externalAgentKind: target.slice(0, separator),
    externalModelSpecifier: target.slice(separator + 1),
    rawDriverOptions: driverOptions,
  });
};

/** Requires an existing directory before a turn reaches session resolution. */
const validatePortableCwd = Effect.fnUntraced(function* (cwd: string) {
  const absoluteCwd = yield* Match.value(path.isAbsolute(cwd)).pipe(
    Match.when(true, () => Effect.succeed(cwd)),
    Match.orElse(
      () =>
        new PortableRequestValidationError({
          message: "Portable Agent working directory must be absolute.",
        }),
    ),
  );
  const metadata = yield* Effect.tryPromise({
    try: () => stat(absoluteCwd),
    catch: () =>
      new PortableRequestValidationError({ message: "Invalid portable Agent working directory." }),
  });
  return yield* Match.value(metadata.isDirectory()).pipe(
    Match.when(true, () => Effect.succeed(cwd)),
    Match.orElse(
      () =>
        new PortableRequestValidationError({
          message: "Invalid portable Agent working directory.",
        }),
    ),
  );
});

/** Starts one diagnostic activity turn and transfers stream ownership to the service registry. */
export const handlePortableAgentStart = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const input = yield* readStartRequest(request);
  const promptByteLength = new TextEncoder().encode(input.prompt).byteLength;
  yield* Match.value(promptByteLength <= 1_048_576).pipe(
    Match.when(true, () => Effect.succeed(input.prompt)),
    Match.orElse(
      () =>
        new PortableRequestValidationError({
          message: "Portable Agent prompt exceeds 1048576 UTF-8 bytes.",
        }),
    ),
  );
  const requestedCwd = yield* validatePortableCwd(input.cwd);
  const turns = yield* PortableAgentTurns;
  const sessionId = input.sessionId ?? `portable-session-${randomUUID()}`;
  const turnId = PortableTurnId.make(`portable-turn-${randomUUID()}`);
  const capability = ObservationCapability.make(randomUUID());
  const target = agentTargetFromPortableRequest(input);
  const driverRegistry = yield* AgentDriverRegistry;
  const driver = yield* driverRegistry.resolve(target);
  yield* driver.preflight({
    target,
    requestedCwd,
    advisories: { effort: undefined, sandboxPosture: "enforced" },
  });
  const turnRequest = {
    identity: { sessionId, parentSessionId: sessionId, turnId },
    origin: { transport: "cli", metadata: input.originMetadata ?? {} },
    advisories: { effort: undefined, sandboxPosture: "enforced" },
    requestedCwd,
    target,
    prompt: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input.prompt }],
        },
      ],
    },
  } as const;
  yield* Option.match(Option.fromUndefinedOr(input.sessionId), {
    onNone: () => Effect.void,
    onSome: () =>
      SessionDirectory.pipe(
        Effect.flatMap((directory) =>
          directory.get(sessionBindingKeyFromTurn({ context: turnRequest, target })),
        ),
        Effect.filterOrFail(
          Option.isSome,
          () =>
            new PortableSessionUnavailable({
              message: `Portable session ${sessionId} is unavailable or already has an in-flight turn.`,
            }),
        ),
        Effect.asVoid,
      ),
  });
  const execution = yield* runAgentTurn(turnRequest);
  const delayRuntimeEvent = (event: AgentRuntimeEvent) =>
    Match.value(event._tag).pipe(
      Match.when("ContentDelta", () =>
        Effect.delay(Effect.succeed<AgentRuntimeEvent>(event), "50 millis"),
      ),
      Match.orElse(() => Effect.succeed<AgentRuntimeEvent>(event)),
    );
  const runtimeEvents = execution.runtimeEvents.pipe(Stream.mapEffect(delayRuntimeEvent));
  yield* turns.register({
    turnId,
    sessionId,
    capability,
    runtimeEvents,
    cancel: execution.cancel,
    onRegistrationFailure: execution.cancel.pipe(Effect.ignore),
  });
  return HttpServerResponse.jsonUnsafe({
    turnId,
    sessionId,
    status: "working",
    observationPath: `/observe/${capability}`,
  });
});

/** Returns one coarse or completed terminal projection without observation details. */
export const handlePortableAgentWait = Effect.fnUntraced(function* ({
  turnId,
  timeoutMillis,
}: {
  readonly turnId: string | undefined;
  readonly timeoutMillis: number;
}) {
  const turns = yield* PortableAgentTurns;
  const portableTurnId = yield* Schema.decodeUnknownEffect(PortableTurnId)(turnId).pipe(
    Effect.mapError(
      () => new PortableRequestValidationError({ message: "Malformed portable turn ID." }),
    ),
  );
  const initial = yield* turns.wait(portableTurnId);
  const shouldWait = Option.exists(initial, (state) => state._tag === "Working");
  const delays = [Effect.sleep(`${timeoutMillis} millis`)].filter(() => shouldWait);
  yield* Effect.all(delays, { discard: true });
  const projection = yield* turns.wait(portableTurnId);
  return yield* Option.match(projection, {
    onNone: () =>
      Effect.succeed(
        portableErrorResponse({
          status: 404,
          kind: "unknown_resource",
          message: "Portable turn not found.",
        }),
      ),
    onSome: (state) =>
      Match.valueTags(state, {
        Working: () =>
          turns.workingHandle(portableTurnId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.succeed(
                    portableErrorResponse({
                      status: 404,
                      kind: "unknown_resource",
                      message: "Portable working turn handle not found.",
                    }),
                  ),
                onSome: ({ sessionId, capability }) =>
                  Effect.succeed(
                    HttpServerResponse.jsonUnsafe({
                      status: "working",
                      turnId: portableTurnId,
                      sessionId,
                      observationPath: `/observe/${capability}`,
                    }),
                  ),
              }),
            ),
          ),
        Completed: ({ finalAnswer }) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "completed", finalAnswer })),
        Failed: () => Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "failed" })),
        Cancelled: ({ outcome, sessionReusable }) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ status: "cancelled", outcome, sessionReusable }),
          ),
      }),
  });
});

/** Cancels one live portable turn through the transport-neutral lifecycle seam. */
export const handlePortableAgentCancel = Effect.fnUntraced(function* ({
  turnId,
}: {
  readonly turnId: string | undefined;
}) {
  const turns = yield* PortableAgentTurns;
  const portableTurnId = yield* Schema.decodeUnknownEffect(PortableTurnId)(turnId).pipe(
    Effect.mapError(
      () => new PortableRequestValidationError({ message: "Malformed portable turn ID." }),
    ),
  );
  const outcome = yield* turns.cancel(portableTurnId);
  return HttpServerResponse.jsonUnsafe({
    status: "cancelled",
    outcome: outcome._tag,
    sessionReusable: outcome.sessionReusable,
  });
});

/** Returns the same generic not-found response for every invalid observation capability. */
const observationNotFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("Not found", { status: 404 });

/** Renders a human observation only when the opaque capability matches. */
export const handlePortableObservation = Effect.fnUntraced(function* ({
  capability,
}: {
  readonly capability: string | undefined;
}) {
  const turns = yield* PortableAgentTurns;
  const observation = yield* turns.observe(
    ObservationCapability.make(capability ?? "invalid-capability"),
  );
  return Option.match(observation, {
    onNone: observationNotFound,
    onSome: (value) =>
      HttpServerResponse.html(renderPortableObservationHtml({ observation: value })),
  });
});

/** Portable start, wait, and capability-viewer HTTP routes. */
const portableStateDir =
  process.env.CAARA_STATE_DIR ??
  path.join(
    process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? process.cwd(), ".local", "state"),
    "caara",
  );

/** Durable portable turn service assembled at the HTTP boundary. */
const durablePortableAgentTurnsLayer = portableAgentTurnsDurableLive({ records: new Map() }).pipe(
  Layer.provide(portableAgentStoreLive({ stateDir: portableStateDir })),
  Layer.provide(BunServices.layer),
);

/** Creates one stable versioned portable transport error. */
const portableErrorResponse = ({
  status,
  kind,
  message,
}: {
  readonly status: number;
  readonly kind: typeof CaaraAgentErrorKind.Type;
  readonly message: string;
}) =>
  HttpServerResponse.jsonUnsafe(
    { schemaVersion: caaraAgentContractVersion, status: "error", error: { kind, message } },
    { status },
  );

/** Parses the optional bounded wait query from one service request URL. */
const portableWaitTimeoutMillisFromUrl = (url: string): number => {
  const rawTimeout = new URL(url, "http://localhost").searchParams.get("timeoutMillis");
  return Option.fromNullishOr(rawTimeout).pipe(
    Option.map(Number),
    Option.getOrElse(() => 0),
  );
};

/** Selects a wait response or explicit timeout validation failure. */
const portableWaitRequest = ({
  turnId,
  timeoutMillis,
}: {
  readonly turnId: string | undefined;
  readonly timeoutMillis: number;
}) => {
  const validTimeout =
    Number.isSafeInteger(timeoutMillis) &&
    timeoutMillis >= 0 &&
    timeoutMillis <= portableAgentWaitMaximumMillis;
  return Match.value(validTimeout).pipe(
    Match.when(true, () => handlePortableAgentWait({ turnId, timeoutMillis })),
    Match.orElse(() =>
      Effect.succeed(
        portableErrorResponse({
          status: 400,
          kind: "invalid_request",
          message: "Invalid timeoutMillis.",
        }),
      ),
    ),
  );
};

/** Portable start, wait, and capability-viewer HTTP routes. */
export const portableAgentRoutesLayerFromTurns = ({
  turnsLayer,
}: {
  readonly turnsLayer: typeof durablePortableAgentTurnsLayer;
}) =>
  Layer.mergeAll(
    HttpRouter.add("POST", "/agent/turns", (request) =>
      handlePortableAgentStart(request).pipe(
        Effect.provide(turnsLayer),
        Effect.catchTags({
          AgentDriverError: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 422,
                kind: "target_failure",
                message: error.message,
              }),
            ),
          TurnConcurrencyConflict: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 409,
                kind: "concurrency_conflict",
                message: error.message,
              }),
            ),
          PortableSessionUnavailable: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 404,
                kind: "unknown_resource",
                message: error.message,
              }),
            ),
        }),
        Effect.orElseSucceed(() =>
          portableErrorResponse({
            status: 400,
            kind: "invalid_request",
            message: "Invalid portable Agent start request.",
          }),
        ),
      ),
    ),
    HttpRouter.add("GET", "/agent/turns/:turnId", (request) =>
      HttpRouter.params.pipe(
        Effect.flatMap(({ turnId }) => {
          const timeoutMillis = portableWaitTimeoutMillisFromUrl(request.url);
          return portableWaitRequest({ turnId, timeoutMillis });
        }),
        Effect.provide(turnsLayer),
        Effect.catchTag("PortableRequestValidationError", (error) =>
          Effect.succeed(
            portableErrorResponse({ status: 400, kind: "invalid_request", message: error.message }),
          ),
        ),
      ),
    ),
    HttpRouter.add("POST", "/agent/turns/:turnId/cancel", () =>
      HttpRouter.params.pipe(
        Effect.flatMap(({ turnId }) => handlePortableAgentCancel({ turnId })),
        Effect.provide(turnsLayer),
        Effect.catchTags({
          PortableRequestValidationError: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 400,
                kind: "invalid_request",
                message: error.message,
              }),
            ),
          PortableTurnNotFound: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 404,
                kind: "unknown_resource",
                message: error.message,
              }),
            ),
          PortableTurnCancellationConflict: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 409,
                kind: "concurrency_conflict",
                message: error.message,
              }),
            ),
          PortableTurnCancellationUnavailable: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 409,
                kind: "concurrency_conflict",
                message: error.message,
              }),
            ),
          AgentTurnCancellationConflict: (error) =>
            Effect.succeed(
              portableErrorResponse({
                status: 409,
                kind: "concurrency_conflict",
                message: error.message,
              }),
            ),
        }),
        Effect.orElseSucceed(() =>
          portableErrorResponse({
            status: 500,
            kind: "target_failure",
            message: "Cancellation failed.",
          }),
        ),
      ),
    ),
    HttpRouter.add("GET", "/observe/:capability", () =>
      HttpRouter.params.pipe(
        Effect.flatMap(({ capability }) => handlePortableObservation({ capability })),
        Effect.provide(turnsLayer),
      ),
    ),
  );

/** Portable routes backed by the process-owned durable turn registry. */
export const portableAgentRoutesLayer = portableAgentRoutesLayerFromTurns({
  turnsLayer: durablePortableAgentTurnsLayer,
});
