import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Match, Option, Schema, Stream } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { AgentRuntimeEvent } from "./mockResponsesProvider/agentDriver.ts";
import { runAgentTurn } from "./mockResponsesProvider/agentTurn.ts";
import { AgentTarget } from "./mockResponsesProvider/codexTurnContext.ts";
import { ObservationCapability, PortableTurnId } from "./portableAgentIdentity.ts";
import { portableAgentStoreLive } from "./portableAgentStore.ts";
import {
  PortableAgentTurns,
  type PortableTurnObservation,
  portableAgentTurnsDurableLive,
} from "./portableAgentTurn.ts";

/** JSON request accepted by the portable diagnostic turn endpoint. */
export const PortableAgentStartRequest = Schema.Struct({ prompt: Schema.NonEmptyString });

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
]);

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
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="1">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Caara turn</title>
<style>body{font:16px system-ui;max-width:72ch;margin:3rem auto;padding:0 1rem;color:#18181b}pre{white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:.5rem}</style></head>
<body><h1>Agent turn</h1><p>Status: ${observation.status}</p><h2>Activity</h2><pre>${escapeHtml(observation.activity)}</pre>${finalAnswerHtml}</body></html>`;
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
  const sessionId = `portable-session-${randomUUID()}`;
  const turnId = PortableTurnId.make(`portable-turn-${randomUUID()}`);
  const capability = ObservationCapability.make(randomUUID());
  const execution = yield* runAgentTurn({
    identity: { sessionId, parentSessionId: sessionId, turnId },
    origin: { transport: "cli", metadata: {} },
    advisories: { effort: undefined, sandboxPosture: "enforced" },
    requestedCwd: process.cwd(),
    target: new AgentTarget({
      requestedModel: "diagnostic/activity",
      externalAgentKind: "diagnostic",
      externalModelSpecifier: "activity",
      rawDriverOptions: { diagnostic_activity_sentinel: input.prompt },
    }),
    prompt: { input: input.prompt },
  });
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
}: {
  readonly turnId: string | undefined;
}) {
  const turns = yield* PortableAgentTurns;
  const projection = yield* turns.wait(PortableTurnId.make(turnId ?? "missing"));
  return Option.match(projection, {
    onNone: () => HttpServerResponse.jsonUnsafe({ error: "not found" }, { status: 404 }),
    onSome: (state) =>
      HttpServerResponse.jsonUnsafe(
        Match.valueTags(state, {
          Working: () => ({ status: "working" }) as const,
          Completed: ({ finalAnswer }) => ({ status: "completed", finalAnswer }) as const,
          Failed: () => ({ status: "failed" }) as const,
        }),
      ),
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
const durablePortableAgentTurnsLayer = portableAgentTurnsDurableLive.pipe(
  Layer.provide(portableAgentStoreLive({ stateDir: portableStateDir })),
  Layer.provide(BunServices.layer),
);

/** Portable start, wait, and capability-viewer HTTP routes. */
export const portableAgentRoutesLayer = Layer.mergeAll(
  HttpRouter.add("POST", "/agent/turns", (request) =>
    handlePortableAgentStart(request).pipe(
      Effect.provide(durablePortableAgentTurnsLayer),
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe({ error: "invalid request" }, { status: 400 }),
      ),
    ),
  ),
  HttpRouter.add("GET", "/agent/turns/:turnId", () =>
    HttpRouter.params.pipe(
      Effect.flatMap(({ turnId }) => handlePortableAgentWait({ turnId })),
      Effect.provide(durablePortableAgentTurnsLayer),
    ),
  ),
  HttpRouter.add("GET", "/observe/:capability", () =>
    HttpRouter.params.pipe(
      Effect.flatMap(({ capability }) => handlePortableObservation({ capability })),
      Effect.provide(durablePortableAgentTurnsLayer),
    ),
  ),
);
