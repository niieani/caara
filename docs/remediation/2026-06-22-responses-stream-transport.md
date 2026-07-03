# Responses stream transport remediation

Date: 2026-06-22

Scope: Codex-facing OpenAI Responses HTTP/SSE transport and runtime-event encoder in
`src/mockResponsesProvider/*`.

Historical note: this remediation predates `CAARA-cglrpxly`. Current accepted driver/request
failures stream `response.failed` with an explicit driver-selected error code. Caara-facing
validation failures use `invalid_prompt`; HTTP 500 JSON is not the desired path for accepted
driver-bound failures.

## Sources read

- `src/mockResponsesProvider/*`
- `src/mockResponsesProvider/*.test.ts`
- `docs/codex-behavior.md`
- `docs/caara.md`
- `docs/adr/2026-06-21-codex-turn-context-separates-responses-transport-from-drivers.md`
- `docs/adr/2026-06-22-client-disconnect-cancels-turn.md`
- `docs/agents/testing-patterns.md`
- `node_modules/@effect/ai-openai/src/OpenAiSchema.ts`
- `node_modules/@effect/ai-openai/src/Generated.ts`
- OpenAI docs MCP: streaming guide, migration guide, `/v1/responses` OpenAPI spec,
  `/v1/responses/{response_id}/cancel` OpenAPI spec
- Codex reference:
  `/Volumes/Projects/SoftwareReferences/codex/codex-rs/codex-api/src/sse/responses.rs`
- Codex reference tests/helpers:
  `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/tests/common/responses.rs`
  `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/tests/suite/stream_no_completed.rs`
  `/Volumes/Projects/SoftwareReferences/codex/sdk/typescript/tests/responsesProxy.ts`

## Executive summary

Enough investigation exists to create fix tasks for the core bug. The current transport can turn
runtime driver stream failure into `response.completed`, then persist a successful session binding.
That is wrong and violates the current docs/ADR promise that unrecoverable driver failures fail
explicitly.

Further investigation is only needed for richer compatibility questions:

- whether Codex Desktop ever calls `POST /v1/responses/{response_id}/cancel` for subagents;
- whether we want full official text-delta lifecycle now, or a Codex-minimum lifecycle first;
- which `@effect/ai-openai` schema should own producer validation, because `OpenAiSchema` is
  narrower than the generated OpenAPI schema.

## Current transport shape

Request flow:

- `server.ts` handles only `POST /v1/responses`.
- `readResponsesCreateRequest` logs diagnostics, then decodes a narrow request shape:
  `model`, `input`, and `stream: true`.
- `decodeCodexTurnRequest` validates Codex identity headers, body `client_metadata`, turn metadata,
  target model shape, and cwd candidates.
- The server resolves an `AgentDriver`, starts/resumes the driver turn, maps
  `AgentRuntimeEvent` values through `responseEvents.ts`, and streams encoded SSE bytes.

Runtime event seam:

- `AgentRuntimeEvent` currently has only `ReasoningDelta` and `AssistantMessage`.
- There is no explicit runtime terminal event.
- There is no runtime event for text deltas, content-part lifecycle, tool calls, permission asks,
  usage, model ids, or final driver outcome metadata.

## Mock/simulator-shaped areas

### Dead mock fixture encoder remains in production source

`createMockResponseEvents` still exists in `responseEvents.ts`, but no current source calls it. It
emits hardcoded fixture ids/text/timestamps from `mockResponsesFixture`.

Remediation:

- Delete it, or move it into tests if still useful as a fixture.
- Remove `mockResponsesFixture` once tests no longer need to prove the simulator differs from the
  original mock.

### Runtime encoder still uses simulator identifiers

Current runtime encoder emits:

- response id: `resp_simulator_driver`
- item ids: `${prefix}_simulator_${outputIndex}`
- timestamp: `mockResponsesFixture.createdAtEpochSeconds` (`1`)

Issues:

- response id is constant across turns;
- item ids advertise simulator internals;
- timestamp is fixture data, not turn time;
- Codex may store the `response.completed.response.id` for future continuation/fork behavior even
  though observed subagent requests did not include `previous_response_id`.

Remediation:

- Generate a unique, stable response id per turn, e.g. derived from `codex.turnId` or generated once
  per accepted request.
- Generate item ids from the same response/turn namespace.
- Use `Clock` for created/completed timestamps; avoid `Date.now` or fixture constants.

### Lifecycle is compressed

Reasoning today:

- emits `response.output_item.added`;
- emits `response.reasoning_summary_text.delta`;
- never emits `response.reasoning_summary_part.added`;
- never emits `response.reasoning_summary_text.done`;
- never emits `response.reasoning_summary_part.done`;
- never emits `response.output_item.done` for the reasoning item;
- final response output stores the reasoning item with `summary: []`, so final output does not
  preserve the streamed summary.

Assistant message today:

- emits one `response.output_item.done` with the entire final text;
- does not emit `response.output_item.added`;
- does not emit `response.content_part.added`;
- does not emit `response.output_text.delta`;
- does not emit `response.output_text.done`;
- does not emit `response.content_part.done`.

This is Codex-compatible for final text, because Codex reference tests commonly use
`response.output_item.done` plus `response.completed`. It is not a faithful streaming text encoder.

### Response object is producer-minimal

`createRuntimeResponse` emits only:

- `id`
- `object`
- `model`
- `created_at`
- `output`

OpenAI examples include richer fields such as `status`, `error`, `incomplete_details`,
`parallel_tool_calls`, `usage`, `previous_response_id`, `reasoning`, `tools`, `tool_choice`, and
`metadata`.

Codex's parser currently needs much less: for `response.completed`, it extracts `id`, optional
usage, and optional `end_turn`. Still, producer-side validation should make the intended contract
explicit rather than relying on permissive clients.

## Failure semantics bug

The main bug is in `server.ts` and `responseEvents.ts`.

Current path:

1. Driver startup failure before a stream is returned became HTTP 500. This historical note is
   superseded for accepted driver-bound failures.
2. Driver runtime stream failure after startup is caught in `server.ts`:
   `Stream.catch((error) => Stream.drain(Stream.fromEffect(relayLogger.log(TurnFailed))))`.
3. That turns the failed runtime stream into a normally completed empty tail.
4. `createResponseEventStreamFromRuntimeEvents` appends `response.completed` through its terminal
   `onHalt` path.
5. `Stream.onExit(finalizeTurn)` sees stream success and runs `completeTurn`.
6. `completeTurn` logs `TurnCompleted` and persists the session binding.

Result:

- Codex receives `response.completed`.
- Caara records a completed turn.
- A possibly broken external session can be persisted as reusable.

This is the inverse of the desired behavior.

## Cancellation semantics

Current client-disconnect path:

- `finalizeTurn` checks `Exit.hasInterrupts`.
- Interrupted stream exits call `driverTurnResult.cancel()`.
- Cancellation outcome decides whether to persist or delete the session binding.

This matches the disconnect ADR for a hanging client stream. Existing tests cover a held-open
simulator turn and two cancellation outcomes.

Gaps:

- Runtime failures are not cancellation and must not be converted into success.
- A driver stream interrupted after partial output needs a regression test too, not just an infinite
  stream with no runtime events.
- If a failed SSE event is emitted as a normal stream terminal event, finalization must still mark
  the turn failed, not completed. Terminal transport outcome must be explicit.

OpenAI has a `POST /v1/responses/{response_id}/cancel` endpoint, but the spec says it is for
background responses. Observed Codex subagent behavior only shows client stream disconnect; no
explicit cancel request has been observed.

## Correct Responses lifecycle target

Official Responses HTTP streaming uses typed SSE events. The common text events are:

- `response.created`
- `response.output_text.delta`
- `response.completed`
- `error`

The `/v1/responses` OpenAPI streaming example shows the fuller text lifecycle:

1. `response.created`
2. `response.in_progress`
3. `response.output_item.added`
4. `response.content_part.added`
5. `response.output_text.delta`
6. `response.output_text.done`
7. `response.content_part.done`
8. `response.output_item.done`
9. `response.completed`

Codex-facing minimum:

- `response.created`
- zero or more supported item/delta events
- exactly one terminal event:
  - `response.completed` for success;
  - `response.failed` for runtime failure;
  - `response.incomplete` for budget/content-filter incomplete responses if we can classify that;
  - no terminal SSE event for client disconnect, because the client is gone.

Never emit `response.completed` after `response.failed`, `response.incomplete`, or client
disconnect.

### Text

Short-term Codex-compatible target:

- For a complete assistant message, emit `response.output_item.done` with a final message item and
  final text, then `response.completed`.
- If the runtime seam starts carrying text deltas, emit `response.output_text.delta` chunks and still
  emit final `response.output_item.done` before `response.completed`.

Full target:

- `response.output_item.added` with message status `in_progress`;
- `response.content_part.added` with empty `output_text`;
- `response.output_text.delta` chunks;
- `response.output_text.done` final text;
- `response.content_part.done`;
- `response.output_item.done` with completed message item;
- `response.completed` with final output array.

### Reasoning

Codex consumes:

- `response.reasoning_summary_text.delta`;
- `response.reasoning_text.delta`;
- reasoning/output items from `response.output_item.added` and `response.output_item.done`.

Target:

- emit a reasoning item with a real id;
- preserve final public reasoning summary in the completed response output when a summary was
  streamed;
- use `response.reasoning_summary_part.added/done` and
  `response.reasoning_summary_text.done` if producer schema support is chosen;
- do not expose raw chain-of-thought unless the upstream SDK explicitly marks it as safe/public
  output. Prefer summary events.

### Runtime failures

Before `response.created` has been sent:

- historical note: this doc previously recommended HTTP 500 JSON. Current accepted driver-bound
  failures should stream `response.failed`; malformed pre-acceptance transport input remains HTTP
  400 `invalid_request_error`.

After SSE has started:

- emit `response.failed` with a response object whose `status` is `failed` and `error.message`
  contains the driver/runtime failure;
- close the stream without `response.completed`;
- log `TurnFailed`;
- release the concurrency lease;
- do not persist a completed session binding.

Important Codex compatibility: Codex reference source handles `response.failed` as a stream error.
It does not currently treat the generic `error` event as a terminal failure in the same parser, so
`response.failed` is safer for this Codex-facing transport even though the official guide lists
`error` among common stream events.

### Incomplete responses

If Caara can classify a terminal condition as incomplete rather than failed, emit
`response.incomplete` with `incomplete_details.reason` set when known. Codex treats
`response.incomplete` as a stream error with the reason in the message.

### Client disconnect

Client disconnect should interrupt server-side streaming:

- call the driver cancel hook;
- log `TurnCancelled`;
- persist only if the driver reports the external session is reusable;
- delete/forget the binding when cancellation can leave hidden mutable context;
- do not attempt to send a terminal SSE event.

## Schema notes

Current tests decode Caara streams with `@effect/ai-openai/OpenAiSchema.ResponseStreamEvent`.

That schema is narrower than the generated OpenAPI schema:

- `OpenAiSchema` includes `response.output_text.delta`, `response.reasoning_summary_text.delta`,
  item events, `response.failed`, `response.incomplete`, and a generic `error`.
- The generated schema includes additional current Responses events, including
  `response.output_text.done`, `response.reasoning_summary_text.done`,
  `response.reasoning_text.delta/done`, and more MCP/custom-tool/apply-patch events.

Decision needed:

- keep `OpenAiSchema` as a Codex-minimum producer validator;
- or switch encoder tests to the generated `ResponseStreamEvent`/`CreateResponse200Sse` schema for
  fuller API conformance;
- or define a local Caara producer schema for the exact event subset Caara promises to Codex.

Do not silently emit events that tests only validate as unknown future events.

## Tests to add or replace

### Pure encoder tests

Add a focused `responseEvents.test.ts` or equivalent.

Cases:

- success with assistant message emits a unique response id, final message item, and terminal
  `response.completed`;
- reasoning delta sequence preserves final summary in response output or explicitly omits reasoning
  final output by design;
- runtime failure terminal emits `response.failed` and never emits `response.completed`;
- sequence numbers are monotonic across every emitted event;
- every emitted known event decodes through the chosen producer schema.

### Server integration tests

Use a test `AgentDriverRegistry` layer instead of simulator query params for failure cases.

Cases:

- historical startup failure behavior is superseded by accepted SSE `response.failed` coverage;
- runtime failure before first runtime event streams `response.created`, then `response.failed`,
  no `response.completed`, logs `TurnFailed`, no `TurnCompleted`, no binding save;
- runtime failure after partial output streams partial events, then `response.failed`, no
  `response.completed`, no binding save;
- a client disconnect after partial output calls driver `cancel`, logs `TurnCancelled`, and does not
  log `TurnCompleted`;
- a failed runtime stream releases the concurrency lease so a later turn for the same Codex thread
  can start;
- failed runtime stream preserves the old binding if one existed, rather than overwriting it with a
  failed turn.

### Existing tests to update

- `mockResponsesProvider.test.ts` currently asserts a happy path with one reasoning delta and one
  final message. Keep that, but update expected event lifecycle once the encoder target is chosen.
- `turnCancellation.test.ts` should keep current disconnected reusable/non-reusable cases and add
  a partial-output cancellation case.
- `sessionBinding.test.ts` and `sessionRecovery.test.ts` should keep success/recovery assertions,
  but add negative assertions that runtime failure does not advance `lastTurnId`.

### Codex compatibility tests

Add a small fixture test based on `docs/codex-behavior.md`:

- request body can include Codex's observed extra fields (`include`, `instructions`, `tools`,
  `parallel_tool_calls`, `store`, `prompt_cache_key`, etc.);
- headers and `client_metadata` identity still validate;
- follow-up turn without workspace metadata can reuse an existing binding.

For failure behavior, mirror Codex reference tests:

- stream closed before `response.completed` is a client-visible stream error;
- `response.failed` is a client-visible stream error;
- `response.completed` stops the stream.

## Compatibility constraints from observed Codex behavior

Observed local Codex behavior:

- Codex calls `POST /v1/responses` with `stream: true`.
- `thread-id` is stable for one spawned subagent handle.
- `turn_id` changes per prompt.
- `session-id` is the parent Codex session id and is shared across spawned subagents.
- `x-codex-window-id` stays stable across turns within one subagent window.
- First turns include workspace metadata; follow-up turns may omit it.
- `previous_response_id` was not observed.
- The selected custom-agent model is visible in body `model`.

Codex reference parser behavior:

- accepts `response.output_item.done` message items as final assistant output;
- accepts `response.output_text.delta` for streaming text;
- accepts `response.reasoning_summary_text.delta` and `response.reasoning_text.delta`;
- accepts `response.output_item.added`/`done` for output items;
- treats `response.failed` as an API/stream error;
- treats `response.incomplete` as an API/stream error;
- treats premature EOF before `response.completed` as `stream closed before response.completed`;
- stops reading once it sees `response.completed`;
- ignores unknown event types.

Implications:

- Do not rely on Codex reading anything after `response.completed`.
- Do not emit generic `error` as the only terminal failure event for Codex until verified.
- Do not emit `response.completed` after runtime failure just to close the stream cleanly.
- Keep final assistant text in `response.output_item.done`; text deltas alone are not enough for
  transcript/history.
- Response ids should become unique even if Codex does not currently send `previous_response_id`.

## Open questions and risks

- Does Codex Desktop ever use `POST /v1/responses/{response_id}/cancel` for subagents, or only
  client disconnect?
- Should runtime driver errors map to retryable `response.failed` errors, fatal invalid-request
  errors, or premature close? Codex currently maps many unknown `response.failed` codes to retryable
  errors.
- If an external agent produced side effects before failing, should Caara allow Codex retry, or
  should the driver mark the external session unusable and surface a fatal failure?
- Can `response.failed` be emitted and flushed reliably if the Effect stream itself fails
  afterward? Safer architecture: model terminal failed as an explicit stream value and make
  finalization aware of terminal outcome.
- Should the encoder grow before or after the Claude SDK driver rewrite? The SDK rewrite likely
  gives richer typed events and should influence the runtime event seam.
- Which schema should be authoritative for producer tests: `OpenAiSchema`, generated OpenAPI schema,
  or local Codex-facing subset?
- Do we need to emit `response.in_progress` for SDK compatibility, or is Codex-minimum sufficient?

## Recommended remediation order

1. Add failing regression tests for runtime stream failure becoming `response.completed`.
2. Introduce an explicit terminal outcome in the transport/encoder path: completed, failed,
   incomplete, cancelled/disconnected.
3. Replace the `Stream.catch(...drain...)` path with terminal-aware failure handling. Runtime
   errors must log `TurnFailed`, release the lease, avoid binding completion, and emit
   `response.failed` if SSE has already started.
4. Make response ids, item ids, and timestamps non-fixture data.
5. Remove or quarantine `createMockResponseEvents` and `mockResponsesFixture`.
6. Decide producer schema: Codex-minimum local schema vs generated OpenAPI schema.
7. Expand assistant/reasoning lifecycle to the chosen target. Minimum first:
   `created -> output_item.done -> completed` for text and
   `created -> reasoning delta(s) -> output_item.done -> completed` where applicable. Full text
   lifecycle can follow once the Claude SDK event seam carries deltas.
8. Add partial-output cancellation and failed-stream session-binding tests.
9. Re-run a Codex subagent smoke test from `docs/agents/smoke-testing.md` after the behavior is
   fixed.
