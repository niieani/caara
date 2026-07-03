# Work Notes

Historical note: this PRD established accepted driver failures as SSE `response.failed`, but its
examples predate `CAARA-cglrpxly`. Current semantics require each `AgentDriverError` to choose an
explicit response code. Caara-facing request, prompt, configuration, and expected startup failures
use `invalid_prompt`; true internal or retryable failures opt into `server_error`.

## Transport Failure Contract

- Accepted driver failures use Responses SSE, never assistant final answers.
- Terminal event: `response.failed`.
- Failed response payload:
  - `response.status: "failed"`;
  - `response.error.code`: explicitly classified by the driver/runtime; historical examples in this
    PRD used `server_error`;
  - `response.error.message: "Caara driver failed: <AgentDriverError.message>"`.
- Success path remains producer-minimal; do not expand completed response objects in this PRD.

## Encoder Shape

- Runtime `TurnFailed` events carry the `AgentDriverError` into `failedEventFromState`.
- Runtime stream errors caught by `createResponseEventStreamFromRuntimeEvents` become
  `RuntimeFailure` transport values that preserve the caught `AgentDriverError`.
- The final halt fallback still emits `response.failed` with an explicit generic driver-stream
  terminal error if no terminal runtime event arrived.

## Accepted Start Failures

- Historical behavior: `server.ts` kept registry failures on JSON error responses before the
  accepted driver boundary. Current behavior streams accepted target-selection and current-turn
  normalization `AgentDriverError` failures as `response.failed` with their explicit response code.
  Malformed transport input remains HTTP `400` `invalid_request_error`.
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
- Existing provider tests were updated from accepted HTTP 500 expectations to SSE failure
  assertions. Later `CAARA-cglrpxly` work also moved unsupported external-agent-kind registry
  failures to the accepted SSE `invalid_prompt` path.

## Claude Native Binary Regression

- Claude SDK activity tests now queue `ClaudeAgentSdkClientError` outcomes before fake runtimes so
  the real Claude driver path can fail from `handleResponsesCreate` after the accepted driver
  boundary.
- Regression uses the observed native CLI message:
  `Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`
- Assertions cover `response.created` then `response.failed`, exact Codex-facing error message,
  no assistant final answer, no `response.completed`, `TurnFailed` logging, no completed Claude
  binding, and a follow-up successful turn in the same provider lifetime.

## Antigravity Process Failure Regression

- Antigravity driver tests now decode raw SSE data for one accepted `agy` process failure so
  `response.failed.response.error.message` can be asserted without the minimal OpenAI schema
  dropping failure fields.
- Regression uses fake mode `process-failure`, proving the real Antigravity driver path reports:
  `Caara driver failed: Antigravity CLI exited with code 23.`
- Assertions cover HTTP 200 `text/event-stream`, `response.created` then `response.failed`, no
  assistant completion item, no `response.completed`, exact `TurnFailed` logging, no completed
  Antigravity binding, and a follow-up successful turn in the same provider lifetime.
