import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Match, Option, Schema, Stream } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { AgentRuntimeEvent } from "./mockResponsesProvider/agentDriver.ts";
import { runAgentTurn } from "./mockResponsesProvider/agentTurn.ts";
import { AgentTarget } from "./mockResponsesProvider/codexTurnContext.ts";
import {
  sessionBindingKeyFromTurn,
  SessionDirectory,
} from "./mockResponsesProvider/sessionDirectory.ts";
import { ObservationCapability, PortableTurnId } from "./portableAgentIdentity.ts";
import { portableAgentStoreLive } from "./portableAgentStore.ts";
import {
  PortableAgentTurns,
  type PortableTurnObservation,
  portableAgentTurnsDurableLive,
} from "./portableAgentTurn.ts";

/** JSON request accepted by the portable diagnostic turn endpoint. */
export const PortableAgentStartRequest = Schema.Struct({
  prompt: Schema.NonEmptyString,
  sessionId: Schema.optional(Schema.NonEmptyString),
  diagnosticCancellationMode: Schema.optional(
    Schema.Literals(["interrupted", "abandoned_reusable", "abandoned_nonreusable", "terminated"]),
  ),
});

/** Service-internal response returned immediately after a portable turn is accepted. */
export const PortableAgentStartServiceResponse = Schema.Struct({
  turnId: PortableTurnId,
  sessionId: Schema.NonEmptyString,
  status: Schema.Literal("working"),
  observationPath: Schema.NonEmptyString,
});

/** Public CLI response with a trusted settings-derived absolute observation URL. */
export const PortableAgentStartResponse = Schema.Struct({
  turnId: PortableTurnId,
  sessionId: Schema.NonEmptyString,
  status: Schema.Literal("working"),
  observationUrl: Schema.NonEmptyString,
});

/** Agent-safe wait response containing no runtime observation fields. */
export const PortableAgentWaitResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("working") }),
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

/** Starts one diagnostic activity turn and transfers stream ownership to the service registry. */
export const handlePortableAgentStart = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const input = yield* readStartRequest(request);
  const turns = yield* PortableAgentTurns;
  const sessionId = input.sessionId ?? `portable-session-${randomUUID()}`;
  const turnId = PortableTurnId.make(`portable-turn-${randomUUID()}`);
  const capability = ObservationCapability.make(randomUUID());
  const diagnosticScenario = Match.value(
    Option.isSome(Option.fromUndefinedOr(input.diagnosticCancellationMode)),
  ).pipe(
    Match.when(true, () => "hangs-until-cancel" as const),
    Match.orElse(() => "activity" as const),
  );
  const target = new AgentTarget({
    requestedModel: `diagnostic/${diagnosticScenario}`,
    externalAgentKind: "diagnostic",
    externalModelSpecifier: diagnosticScenario,
    rawDriverOptions: {
      diagnostic_activity_sentinel: input.prompt,
      ...Option.match(Option.fromUndefinedOr(input.diagnosticCancellationMode), {
        onNone: () => ({}),
        onSome: (mode) => ({ diagnostic_cancel: mode }),
      }),
    },
  });
  const turnRequest = {
    identity: { sessionId, parentSessionId: sessionId, turnId },
    origin: { transport: "cli", metadata: {} },
    advisories: { effort: undefined, sandboxPosture: "enforced" },
    requestedCwd: process.cwd(),
    target,
    prompt: { input: input.prompt },
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
  const portableTurnId = PortableTurnId.make(turnId ?? "missing");
  const initial = yield* turns.wait(portableTurnId);
  const shouldWait = Option.exists(initial, (state) => state._tag === "Working");
  const delays = [Effect.sleep(`${timeoutMillis} millis`)].filter(() => shouldWait);
  yield* Effect.all(delays, { discard: true });
  const projection = yield* turns.wait(portableTurnId);
  return Option.match(projection, {
    onNone: () => HttpServerResponse.jsonUnsafe({ error: "not found" }, { status: 404 }),
    onSome: (state) =>
      HttpServerResponse.jsonUnsafe(
        Match.valueTags(state, {
          Working: () => ({ status: "working" }) as const,
          Completed: ({ finalAnswer }) => ({ status: "completed", finalAnswer }) as const,
          Failed: () => ({ status: "failed" }) as const,
          Cancelled: ({ outcome, sessionReusable }) =>
            ({ status: "cancelled", outcome, sessionReusable }) as const,
        }),
      ),
  });
});

/** Cancels one live portable turn through the transport-neutral lifecycle seam. */
export const handlePortableAgentCancel = Effect.fnUntraced(function* ({
  turnId,
}: {
  readonly turnId: string | undefined;
}) {
  const turns = yield* PortableAgentTurns;
  const outcome = yield* turns.cancel(PortableTurnId.make(turnId ?? "missing"));
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
        HttpServerResponse.jsonUnsafe({ error: "invalid timeoutMillis" }, { status: 400 }),
      ),
    ),
  );
};

/** Portable start, wait, and capability-viewer HTTP routes. */
export const portableAgentRoutesLayer = Layer.mergeAll(
  HttpRouter.add("POST", "/agent/turns", (request) =>
    handlePortableAgentStart(request).pipe(
      Effect.provide(durablePortableAgentTurnsLayer),
      Effect.catchTags({
        TurnConcurrencyConflict: (error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 409 })),
        PortableSessionUnavailable: (error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 409 })),
      }),
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 }),
      ),
    ),
  ),
  HttpRouter.add("GET", "/agent/turns/:turnId", (request) =>
    HttpRouter.params.pipe(
      Effect.flatMap(({ turnId }) => {
        const timeoutMillis = portableWaitTimeoutMillisFromUrl(request.url);
        return portableWaitRequest({ turnId, timeoutMillis });
      }),
      Effect.provide(durablePortableAgentTurnsLayer),
    ),
  ),
  HttpRouter.add("POST", "/agent/turns/:turnId/cancel", () =>
    HttpRouter.params.pipe(
      Effect.flatMap(({ turnId }) => handlePortableAgentCancel({ turnId })),
      Effect.provide(durablePortableAgentTurnsLayer),
      Effect.catchTags({
        PortableTurnNotFound: (error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 404 })),
        PortableTurnCancellationConflict: (error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 409 })),
        PortableTurnCancellationUnavailable: (error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 409 })),
        AgentTurnCancellationConflict: (error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 409 })),
      }),
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe({ error: "cancellation failed" }, { status: 500 }),
      ),
    ),
  ),
  HttpRouter.add("GET", "/observe/:capability", () =>
    HttpRouter.params.pipe(
      Effect.flatMap(({ capability }) => handlePortableObservation({ capability })),
      Effect.provide(durablePortableAgentTurnsLayer),
    ),
  ),
);
