import { Console, Context, Effect, Layer, Schema } from "effect";

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

/** Structured relay event emitted around Codex-to-driver turn processing. */
export type RelayLogEvent =
  | TurnAcceptedRelayEvent
  | TargetSelectedRelayEvent
  | DriverStartedRelayEvent
  | RuntimeEventRelayedRelayEvent
  | TurnCompletedRelayEvent
  | TurnFailedRelayEvent;

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
