# Work Notes

## Transport Failure Contract

- Accepted driver failures use Responses SSE, never assistant final answers.
- Terminal event: `response.failed`.
- Failed response payload:
  - `response.status: "failed"`;
  - `response.error.code: "server_error"`;
  - `response.error.message: "Caara driver failed: <AgentDriverError.message>"`.
- Success path remains producer-minimal; do not expand completed response objects in this PRD.

## Encoder Shape

- Runtime `TurnFailed` events carry the `AgentDriverError` into `failedEventFromState`.
- Runtime stream errors caught by `createResponseEventStreamFromRuntimeEvents` become
  `RuntimeFailure` transport values that preserve the caught `AgentDriverError`.
- The final halt fallback still emits `response.failed` with an explicit generic driver-stream
  terminal error if no terminal runtime event arrived.

## Accepted Start Failures

- `server.ts` keeps registry/transport validation errors on JSON error responses before the accepted
  driver boundary.
- Once Caara has logged `DriverStarted`, a `startOrResumeTurn` `AgentDriverError` becomes a
  synthetic failed driver turn result:
  - runtime stream: one `TurnFailed` event;
  - external session: ephemeral placeholder never persisted because failed turns only release;
  - cancel hook: terminated/non-reusable no-op.
- The normal runtime encoder/finalizer path then emits `response.created`, `response.failed`, logs
  `TurnFailed`, releases the lease, and avoids `TurnCompleted` / session binding completion.

## Test Shape

- Pure encoder tests can assert raw event payloads directly.
- Provider tests that need non-minimal response fields decode SSE data as `Schema.Unknown`, because
  `OpenAiSchema.ResponseStreamEvent` intentionally drops response fields outside its minimal local
  `Response` schema.
- Existing provider tests were updated from accepted HTTP 500 expectations to SSE failure assertions;
  registry failures before `DriverStarted` still assert JSON transport errors.
