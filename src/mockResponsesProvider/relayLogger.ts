import { Console, Context, Effect, Layer, Schema } from "effect";

import { CaaraAppLogWriter } from "../caaraLogging.ts";

/** Relay event recorded when a Codex turn is accepted by the transport. */
export interface TurnAcceptedRelayEvent {
  readonly _tag: "TurnAccepted";
  readonly threadId: string;
  readonly turnId: string;
}

/** Relay event recorded when model/query params select an external agent target. */
export interface TargetSelectedRelayEvent {
  readonly _tag: "TargetSelected";
  readonly threadId: string;
  readonly turnId: string;
  readonly requestedModel: string;
  readonly externalAgentKind: string;
  readonly externalModelSpecifier: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
}

/** Relay event recorded immediately before a driver turn starts. */
export interface DriverStartedRelayEvent {
  readonly _tag: "DriverStarted";
  readonly threadId: string;
  readonly turnId: string;
  readonly externalAgentKind: string;
  readonly externalSessionId?: string;
  readonly previousTarget?: {
    readonly requestedModel: string;
    readonly externalAgentKind: string;
    readonly externalModelSpecifier: string;
    readonly rawDriverOptions: Readonly<Record<string, string>>;
  };
}

/** Relay event recorded for each normalized driver runtime event. */
export interface RuntimeEventRelayedRelayEvent {
  readonly _tag: "RuntimeEventRelayed";
  readonly threadId: string;
  readonly turnId: string;
  readonly runtimeEventTag: string;
}

/** Relay event recorded when a turn successfully finishes. */
export interface TurnCompletedRelayEvent {
  readonly _tag: "TurnCompleted";
  readonly threadId: string;
  readonly turnId: string;
}

/** Relay event recorded when driver startup or runtime fails. */
export interface TurnFailedRelayEvent {
  readonly _tag: "TurnFailed";
  readonly threadId: string;
  readonly turnId: string;
  readonly message: string;
}

/** Relay event recorded when an overlapping turn is rejected for a session key. */
export interface TurnConcurrencyConflictRelayEvent {
  readonly _tag: "TurnConcurrencyConflict";
  readonly externalAgentKind: string;
  readonly codexThreadId: string;
  readonly incomingTurnId: string;
  readonly runningTurnId: string;
}

/** Relay event recorded after a turn acquires in-flight ownership for a session key. */
export interface TurnInFlightAcquiredRelayEvent {
  readonly _tag: "TurnInFlightAcquired";
  readonly externalAgentKind: string;
  readonly codexThreadId: string;
  readonly turnId: string;
}

/** Relay event recorded after a disconnected stream cancels an in-flight turn. */
export interface TurnCancelledRelayEvent {
  readonly _tag: "TurnCancelled";
  readonly externalAgentKind: string;
  readonly codexThreadId: string;
  readonly turnId: string;
  readonly outcomeTag: string;
  readonly sessionReusable: boolean;
}

/** Relay event recorded when Caara replaces a lost external-agent session. */
export interface LostSessionRecoveredRelayEvent {
  readonly _tag: "LostSessionRecovered";
  readonly threadId: string;
  readonly turnId: string;
  readonly reason: string;
  readonly diagnostics: Readonly<Record<string, string>>;
}

/** Relay event recorded when an external agent permission request is denied. */
export interface PermissionDeniedRelayEvent {
  readonly _tag: "PermissionDenied";
  readonly threadId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly message: string;
  readonly decisionReason: string | undefined;
}

/** Structured relay event emitted around Codex-to-driver turn processing. */
export type RelayLogEvent =
  | TurnAcceptedRelayEvent
  | TargetSelectedRelayEvent
  | DriverStartedRelayEvent
  | RuntimeEventRelayedRelayEvent
  | TurnCompletedRelayEvent
  | TurnFailedRelayEvent
  | TurnConcurrencyConflictRelayEvent
  | TurnInFlightAcquiredRelayEvent
  | TurnCancelledRelayEvent
  | LostSessionRecoveredRelayEvent
  | PermissionDeniedRelayEvent;

/** Logs structured relay events for observability and test artifact capture. */
export class RelayLogger extends Context.Service<
  RelayLogger,
  {
    readonly log: (event: RelayLogEvent) => ReturnType<typeof Console.log>;
  }
>()("@caara/RelayLogger") {}

/** Encodes one relay event as a stable JSON log line. */
export const encodeRelayLogLine = (event: RelayLogEvent): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)({
    event: "caara.relay",
    ...event,
  });

/** Live relay logger that writes JSON relay events to stdout. */
export const relayLoggerLive = Layer.succeed(RelayLogger, {
  log: Effect.fnUntraced(function* (event: RelayLogEvent) {
    yield* Console.log(encodeRelayLogLine(event));
  }),
});

/** Relay logger that writes to both foreground console and the app-owned JSONL log. */
export const relayLoggerWithAppLogLive = Layer.effect(
  RelayLogger,
  Effect.gen(function* () {
    const appLog = yield* CaaraAppLogWriter;
    return {
      log: Effect.fnUntraced(function* (event: RelayLogEvent) {
        const line = encodeRelayLogLine(event);
        yield* Effect.all([Console.log(line), appLog.writeLine(line).pipe(Effect.orDie)], {
          discard: true,
        });
      }),
    };
  }),
);
