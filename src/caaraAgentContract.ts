import { Match, Schema } from "effect";

import { PortableSessionId, PortableTurnId } from "./portableAgentIdentity.ts";

/** Wire-format version for every public portable Agent command result. */
export const caaraAgentContractVersion = 1 as const;

/** Stable process exit codes exposed by `caara agent`. */
export const CaaraAgentExitCode = {
  Completed: 0,
  Accepted: 10,
  Working: 11,
  Failed: 20,
  Cancelled: 21,
  InvalidRequest: 64,
  UnknownResource: 66,
  ServiceUnavailable: 69,
  TargetFailure: 70,
  ConcurrencyConflict: 75,
} as const;

/** Stable error kinds returned at the CLI transport boundary. */
export const CaaraAgentErrorKind = Schema.Literals([
  "invalid_request",
  "service_unavailable",
  "unknown_resource",
  "target_failure",
  "concurrency_conflict",
]);

/** Versioned machine-readable command error. */
export const PortableAgentErrorResult = Schema.Struct({
  schemaVersion: Schema.Literal(caaraAgentContractVersion),
  status: Schema.Literal("error"),
  error: Schema.Struct({ kind: CaaraAgentErrorKind, message: Schema.NonEmptyString }),
});

/** Versioned accepted start result. */
export const PortableAgentStartResult = Schema.Struct({
  schemaVersion: Schema.Literal(caaraAgentContractVersion),
  turnId: PortableTurnId,
  sessionId: PortableSessionId,
  status: Schema.Literal("accepted"),
  observationUrl: Schema.NonEmptyString,
});

/** Versioned bounded-wait result, excluding the human observation plane. */
export const PortableAgentWaitResult = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal(caaraAgentContractVersion),
    status: Schema.Literal("working"),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(caaraAgentContractVersion),
    status: Schema.Literal("completed"),
    finalAnswer: Schema.String,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(caaraAgentContractVersion),
    status: Schema.Literal("failed"),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal(caaraAgentContractVersion),
    status: Schema.Literal("cancelled"),
    outcome: Schema.Literals(["Interrupted", "Abandoned", "Terminated"]),
    sessionReusable: Schema.Boolean,
  }),
]);

/** Versioned cancellation result. */
export const PortableAgentCancelResult = Schema.Struct({
  schemaVersion: Schema.Literal(caaraAgentContractVersion),
  status: Schema.Literal("cancelled"),
  outcome: Schema.Literals(["Interrupted", "Abandoned", "Terminated"]),
  sessionReusable: Schema.Boolean,
});

/** Complete versioned schema emitted by every portable Agent command. */
export const PortableAgentCommandResultSchema = Schema.Union([
  PortableAgentStartResult,
  PortableAgentWaitResult,
  PortableAgentCancelResult,
  PortableAgentErrorResult,
]);

/** Complete typed result rendered by the portable CLI. */
export type PortableAgentCommandResult =
  | typeof PortableAgentStartResult.Type
  | typeof PortableAgentWaitResult.Type
  | typeof PortableAgentCancelResult.Type
  | typeof PortableAgentErrorResult.Type;

/** Maps one typed command result to its documented process status. */
export const agentExitCode = (result: PortableAgentCommandResult): number =>
  Match.value(result).pipe(
    Match.when(
      { status: "error", error: { kind: "invalid_request" } },
      () => CaaraAgentExitCode.InvalidRequest,
    ),
    Match.when(
      { status: "error", error: { kind: "service_unavailable" } },
      () => CaaraAgentExitCode.ServiceUnavailable,
    ),
    Match.when(
      { status: "error", error: { kind: "unknown_resource" } },
      () => CaaraAgentExitCode.UnknownResource,
    ),
    Match.when(
      { status: "error", error: { kind: "target_failure" } },
      () => CaaraAgentExitCode.TargetFailure,
    ),
    Match.when(
      { status: "error", error: { kind: "concurrency_conflict" } },
      () => CaaraAgentExitCode.ConcurrencyConflict,
    ),
    Match.when({ status: "accepted" }, () => CaaraAgentExitCode.Accepted),
    Match.when({ status: "working" }, () => CaaraAgentExitCode.Working),
    Match.when({ status: "failed" }, () => CaaraAgentExitCode.Failed),
    Match.when({ status: "cancelled" }, () => CaaraAgentExitCode.Cancelled),
    Match.orElse(() => CaaraAgentExitCode.Completed),
  );

/** Renders concise human output from the exact typed machine result. */
export const renderAgentResult = (result: PortableAgentCommandResult): string =>
  Match.value(result).pipe(
    Match.when(
      { status: "accepted" },
      (value) =>
        `Accepted ${value.turnId}\nSession: ${value.sessionId}\nObserve: ${value.observationUrl}`,
    ),
    Match.when({ status: "working" }, () => "Working"),
    Match.when({ status: "completed" }, ({ finalAnswer }) => `Completed\n${finalAnswer}`),
    Match.when({ status: "failed" }, () => "Failed"),
    Match.when(
      { status: "cancelled" },
      ({ outcome, sessionReusable }) =>
        `Cancelled: ${outcome} (session reusable: ${String(sessionReusable)})`,
    ),
    Match.when({ status: "error" }, ({ error }) => `Error: ${error.message}`),
    Match.exhaustive,
  );
