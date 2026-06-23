import { Effect, Stream } from "effect";

import type { AgentRuntimeEvent } from "./agentDriver.ts";
import type { ResponsesCreateRequest } from "./protocol.ts";
import {
  runtimeTransportEventToSseEvents,
  terminalEventsFromState,
  type RuntimeTransportEvent,
} from "./runtimeResponseEncoder.ts";
import { initialRuntimeResponseState } from "./runtimeResponseTypes.ts";
import type { SseEvent } from "./sse.ts";

export { createResponseEventsFromRuntimeEvents } from "./runtimeResponseEncoder.ts";

/** Default no-op side effect run when a runtime stream fails. */
const defaultRuntimeFailureHandler = Effect.fnUntraced(function* () {
  yield* Effect.void;
});

/** Streams Responses-compatible SSE frames from normalized driver runtime events. */
export const createResponseEventStreamFromRuntimeEvents = <E, R>({
  request,
  runtimeEvents,
  onRuntimeFailure = () => defaultRuntimeFailureHandler(),
}: {
  readonly request: ResponsesCreateRequest;
  readonly runtimeEvents: Stream.Stream<AgentRuntimeEvent, E, R>;
  readonly onRuntimeFailure?: (error: E) => ReturnType<typeof defaultRuntimeFailureHandler>;
}): Stream.Stream<SseEvent, never, R> => {
  const initial = initialRuntimeResponseState({ request });
  const transportEvents = runtimeEvents.pipe(
    Stream.map(
      (runtimeEvent): RuntimeTransportEvent => ({
        _tag: "RuntimeEvent",
        runtimeEvent,
      }),
    ),
    Stream.catch((error) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          yield* onRuntimeFailure(error);
          return {
            _tag: "RuntimeFailure",
          } satisfies RuntimeTransportEvent;
        }),
      ),
    ),
  );
  const runtimeResponseEvents = transportEvents.pipe(
    Stream.mapAccum(
      () => initial.state,
      (state, transportEvent) =>
        runtimeTransportEventToSseEvents({ request, state, transportEvent }),
      {
        onHalt: (state) => terminalEventsFromState({ request, state }),
      },
    ),
  );
  return Stream.fromIterable([initial.createdEvent]).pipe(Stream.concat(runtimeResponseEvents));
};
