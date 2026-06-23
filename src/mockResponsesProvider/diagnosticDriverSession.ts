import { Effect, Match, Option, Schema } from "effect";

import {
  AgentDriverError,
  type AgentCancellationOutcome,
  type AgentDriverTurn,
} from "./agentDriver.ts";
import { diagnosticDriverFixture } from "./diagnosticDriverFixtures.ts";
import {
  DurableExternalSession,
  type ExternalSessionState,
  makeDriverResumeCursor,
} from "./sessionDirectory.ts";

/** Driver-owned Diagnostic resume cursor schema encoded as an opaque core string. */
class DiagnosticResumeCursor extends Schema.Class<DiagnosticResumeCursor>("DiagnosticResumeCursor")(
  {
    sessionId: Schema.NonEmptyString,
  },
) {}

/** Encodes a Diagnostic session id into the driver's opaque resume cursor string. */
const encodeDiagnosticResumeCursor = (sessionId: string): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)(new DiagnosticResumeCursor({ sessionId }));

/** Decodes and validates a Diagnostic resume cursor owned by the Diagnostic driver. */
const decodeDiagnosticResumeCursor = Effect.fnUntraced(function* (driverResumeCursor: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DiagnosticResumeCursor))(
    driverResumeCursor,
  ).pipe(
    Effect.mapError(
      () => new AgentDriverError({ message: "Invalid diagnostic driver resume cursor." }),
    ),
  );
});

/** Builds the first durable Diagnostic session for a new binding. */
const initialDiagnosticExternalSession = () =>
  new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(
      encodeDiagnosticResumeCursor(diagnosticDriverFixture.basicExternalSessionId),
    ),
  });

/** Validates an existing Diagnostic external session before reuse. */
const validateDiagnosticExternalSession = Effect.fnUntraced(function* (
  externalSession: ExternalSessionState,
) {
  return yield* Match.value(externalSession).pipe(
    Match.tags({
      Durable: (durableSession) =>
        Effect.map(
          decodeDiagnosticResumeCursor(durableSession.driverResumeCursor),
          () => durableSession,
        ),
      Ephemeral: () => Effect.succeed(externalSession),
    }),
    Match.exhaustive,
  );
});

/** Returns the durable Diagnostic session after validating an existing cursor when present. */
export const diagnosticExternalSession = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  const externalSessionEffect = Option.match(Option.fromUndefinedOr(turn.externalSession), {
    onNone: () => Effect.succeed(initialDiagnosticExternalSession()),
    onSome: validateDiagnosticExternalSession,
  });
  return yield* externalSessionEffect;
});

/** Builds a fresh durable Diagnostic session after lost-continuity recovery. */
export const recoveredDiagnosticExternalSession = () =>
  new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(
      encodeDiagnosticResumeCursor(diagnosticDriverFixture.recoveredExternalSessionId),
    ),
  });

/** Extracts the previous durable Diagnostic cursor for recovery diagnostics. */
export const previousDiagnosticCursor = (turn: AgentDriverTurn): string =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(
      [turn.externalSession]
        .filter((session): session is DurableExternalSession => session?._tag === "Durable")
        .map((session) => session.driverResumeCursor)
        .at(0),
    ),
  ) ?? "unknown";

/** Returns the Diagnostic cancellation mode requested by driver options. */
const diagnosticCancellationMode = (turn: AgentDriverTurn): string =>
  turn.target.rawDriverOptions.diagnostic_cancel ?? "interrupted";

/** Validates the optional Diagnostic cancellation mode query parameter. */
export const validateDiagnosticCancellationOption = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  return yield* Option.match(Option.fromUndefinedOr(rawDriverOptions.diagnostic_cancel), {
    onNone: () => Effect.void,
    onSome: (mode) =>
      Match.value(mode).pipe(
        Match.when("interrupted", () => Effect.void),
        Match.when("abandoned_reusable", () => Effect.void),
        Match.when("abandoned_nonreusable", () => Effect.void),
        Match.when("terminated", () => Effect.void),
        Match.orElse(() =>
          Effect.fail(
            new AgentDriverError({
              message: `Unsupported diagnostic_cancel value: ${mode}.`,
            }),
          ),
        ),
      ),
  });
});

/** Builds the Diagnostic cancellation outcome for one in-flight turn. */
export const diagnosticCancellationOutcome = (turn: AgentDriverTurn): AgentCancellationOutcome =>
  Match.value(diagnosticCancellationMode(turn)).pipe(
    Match.when(
      "abandoned_reusable",
      () =>
        ({
          _tag: "Abandoned",
          sessionReusable: true,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.when(
      "abandoned_nonreusable",
      () =>
        ({
          _tag: "Abandoned",
          sessionReusable: false,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.when(
      "terminated",
      () =>
        ({
          _tag: "Terminated",
          sessionReusable: false,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.orElse(
      () =>
        ({
          _tag: "Interrupted",
          sessionReusable: true,
        }) satisfies AgentCancellationOutcome,
    ),
  );
