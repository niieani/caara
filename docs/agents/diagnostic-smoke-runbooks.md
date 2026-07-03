# Diagnostic Driver Smoke Runbooks

Use these runbooks to verify Caara behavior without invoking Claude. Diagnostic scenarios run
through the same Responses transport, runtime encoder, relay logger, session directory, recovery,
and cancellation paths as real drivers.

## Common Setup

Start the local provider from the repo root:

```bash
CAARA_STATE_DIR="$PWD/temp.local/$(date +%F)/diagnostic-state" bun run start 2>&1 | tee "$PWD/temp.local/$(date +%F)/diagnostic-provider.log"
```

Expected startup line:

```text
Listening on http://localhost:8787
```

Optional health preflight from another terminal:

```bash
bun src/caara.ts status
```

Expected output:

```text
Caara healthy at http://127.0.0.1:8787/health
```

Installed-service status and health behavior is documented in
[docs/caara.md](../caara.md#user-service-and-operations).

For Codex subagent path smokes, use one of the checked-in Diagnostic roles:

- `caara-diagnostic-basic`
- `caara-diagnostic-reasoning`
- `caara-diagnostic-activity`
- `caara-diagnostic-fails-before-output`
- `caara-diagnostic-fails-after-partial`
- `caara-diagnostic-fails-invalid-request`
- `caara-diagnostic-hangs-until-cancel`
- `caara-diagnostic-recovery`
- `caara-diagnostic-echo`

The checked-in `caara-claude` role is Claude-specific (`claude/haiku`). If a running Codex thread's
multi-agent tool does not expose newly added Diagnostic roles, record that as a role-discovery
blocker and run the direct-provider fallback below for scenario evidence.

To verify Codex dynamic effort serialization, change Codex's effort selector, run any Diagnostic
role, and inspect the retained provider log:

```bash
rg '"event":"caara.responses.request"|"reasoning"|"effort"' "$PWD/temp.local/$(date +%F)/diagnostic-provider.log"
```

Expected: the logged request body includes `reasoning.effort` with the selected dynamic effort.
Diagnostic scenarios only prove Codex-to-Caara advisory decoding; real driver behavior remains
driver-owned.

Direct-provider fallback requests must still be Codex-shaped: include Codex identity headers,
`stream: true`, `client_metadata.thread_id`, `client_metadata.turn_id`, and `metadata.cwd` when the
turn should create or reuse a workspace-bound session.

Minimal direct request shape:

```json
{
  "model": "diagnostic/basic",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "diagnostic smoke" }]
    }
  ],
  "stream": true,
  "client_metadata": {
    "thread_id": "diagnostic-smoke-thread",
    "turn_id": "diagnostic-smoke-turn-1"
  },
  "metadata": {
    "cwd": "/Volumes/Projects/Software/code-agents-as-responses-api"
  }
}
```

Relay evidence always starts with `TargetSelected` where `externalAgentKind` is `diagnostic`. If
logs show `externalAgentKind` `claude`, the smoke is exercising the Claude driver, not Diagnostic.
Diagnostic relay logs never contain Claude SDK session ids, Claude tool names, or Claude permission
events.

## Scenario Matrix

| Scenario | Model specifier | Query params |
| --- | --- | --- |
| Basic | `diagnostic/basic` | `diagnostic_answer_text`, `diagnostic_chunk_count`, `diagnostic_delay_ms` |
| Reasoning | `diagnostic/reasoning` | none |
| Activity | `diagnostic/activity` | `diagnostic_activity=off` optional |
| Fails before output | `diagnostic/fails-before-output` | none |
| Fails after partial | `diagnostic/fails-after-partial` | none |
| Hangs until cancel | `diagnostic/hangs-until-cancel` | `diagnostic_cancel=interrupted`, `abandoned_reusable`, `abandoned_nonreusable`, or `terminated` |
| Recovery | `diagnostic/recovery` | `diagnostic_fresh_start=failure` optional |
| Echo | `diagnostic/echo` | none |

Unsupported Diagnostic option names, invalid values, and unknown scenarios should fail explicitly.

## Basic

Goal: prove a normal Diagnostic turn succeeds and persists a reusable Diagnostic binding.

Codex prompt:

```text
Run a Diagnostic basic smoke. Reply only with the final provider answer.
```

Direct-provider model: `diagnostic/basic`.

Useful query params:

- `diagnostic_answer_text=custom%20diagnostic%20answer`
- `diagnostic_chunk_count=3`
- `diagnostic_delay_ms=0`

Expected Codex-visible output:

- First turn default: `Diagnostic basic completed diagnostic/basic`.
- With `diagnostic_answer_text`, the exact configured answer text.
- Follow-up on the same Codex thread: `Diagnostic basic resumed prior session with previous target`.

Expected relay logs:

- `TargetSelected` with `externalAgentKind: "diagnostic"` and `externalModelSpecifier: "basic"`.
- `DriverStarted`; on follow-up it includes `previousTarget`.
- Runtime item lifecycle events for assistant text.
- `TurnCompleted`.

Expected binding:

- Binding key external agent kind `diagnostic`, driver instance id `diagnostic`, same Codex thread id.
- Durable cursor `{"sessionId":"diagnostic-session-codex-thread-diagnostic-basic"}`.
- Follow-up keeps the same cursor and advances `lastTurnId`.

Known failure signatures:

- Invalid chunk/delay values: `Diagnostic driver option ... must be an integer`.
- Unknown query param: `Unsupported diagnostic driver option`.

## Reasoning

Goal: prove displayable reasoning summaries use Codex reasoning items, not assistant commentary.

Codex prompt:

```text
Run a Diagnostic reasoning smoke. Report the final answer only.
```

Direct-provider model: `diagnostic/reasoning`.

Expected Codex-visible output:

- Reasoning summary is displayed through Codex reasoning UI/events.
- Final assistant answer: `Diagnostic basic completed diagnostic/basic`.
- No raw/private thinking appears as assistant text.

Expected relay logs:

- `TargetSelected` with `externalModelSpecifier: "reasoning"`.
- Runtime event order: reasoning item created, reasoning content delta/completion, assistant message
  item lifecycle, `TurnSucceeded`, `TurnCompleted`.

Expected binding:

- Successful turn persists a Diagnostic durable cursor.

Known failure signatures:

- Reasoning text as assistant commentary means the wrong Responses channel was used.
- Missing `response.completed` means the runtime terminal event did not reach the encoder.

## Activity

Goal: prove driver-neutral activity commentary and activity opt-out.

Codex prompt:

```text
Run a Diagnostic activity smoke. Return the final answer.
```

Direct-provider model: `diagnostic/activity`.

Useful query params:

- Default: commentary visible.
- `diagnostic_activity=off`: commentary hidden from Codex-visible SSE, relay lifecycle preserved.

Expected Codex-visible output:

- Default commentary messages:
  - `Reading src/server.ts`
  - `Editing src/mockResponsesProvider/server.ts`
- Final answer: `Diagnostic activity completed with final answer`.
- With `diagnostic_activity=off`, only the final answer is visible.

Expected relay logs:

- `TargetSelected` with `externalModelSpecifier: "activity"`.
- Runtime lifecycle records for hidden and visible activity.
- `TurnCompleted`.

Expected binding:

- Successful turn persists or updates the Diagnostic durable cursor.

Known failure signatures:

- Activity emitted as function call, custom tool call, tool output, annotation, stdout, stderr, or
  JSON payload means the Codex channel-safety contract is broken.

## Fails Before Output

Goal: prove startup/runtime failure before user-visible output becomes terminal failure, not success.

Codex prompt:

```text
Run a Diagnostic fails-before-output smoke. The expected result is provider failure.
```

Direct-provider model: `diagnostic/fails-before-output`.

Expected Codex-visible output:

- OpenAI-shaped failure response or `response.failed`.
- No assistant output text.
- No `response.completed`.

Expected relay logs:

- `TargetSelected` with `externalModelSpecifier: "fails-before-output"`.
- `DriverStarted`.
- `TurnFailed` with the Diagnostic failure message.

Expected binding:

- No new binding is created or completed for the failed turn.

Known failure signatures:

- `response.completed` after failure means the old stream-transport bug regressed.
- A new binding after failure means failed sessions are being persisted as successful.

## Fails After Partial

Goal: prove partial runtime output followed by failure cannot complete or advance a binding.

Codex prompt:

```text
Run a Diagnostic fails-after-partial smoke. The expected result is a partial stream then provider failure.
```

Direct-provider model: `diagnostic/fails-after-partial`.

Expected Codex-visible output:

- Partial reasoning summary may appear.
- Terminal `response.failed`.
- No final assistant answer and no `response.completed`.

Expected relay logs:

- Runtime reasoning item events before failure.
- `TurnFailed` with the Diagnostic after-partial failure message.

Expected binding:

- If no prior binding exists, no binding is created.
- If a prior binding exists, it remains unchanged and `lastTurnId` is not advanced to the failed
  turn.

Known failure signatures:

- Final answer after the partial failure means a failed runtime stream was converted to success.

## Hangs Until Cancel

Goal: prove Codex client disconnect cancels the in-flight turn and exercises binding reuse/deletion.
This is also a Codex client canary: if Codex changes how it cancels subagent streams, this smoke
should catch the change.

Codex prompt:

```text
Run a Diagnostic hangs-until-cancel smoke. Do not finish; keep the response stream open until I close this subagent.
```

Direct-provider model: `diagnostic/hangs-until-cancel`.

Useful query params:

- `diagnostic_cancel=interrupted`: `Interrupted`, reusable.
- `diagnostic_cancel=abandoned_reusable`: `Abandoned`, reusable.
- `diagnostic_cancel=abandoned_nonreusable`: `Abandoned`, non-reusable.
- `diagnostic_cancel=terminated`: `Terminated`, non-reusable.

Expected Codex-visible output:

- No final answer before cancellation.
- The subagent or direct stream remains running until closed/interrupted.

Expected relay logs:

- `TurnInFlightAcquired` for the held turn.
- On client close/disconnect: `TurnCancelled` with `outcomeTag` and `sessionReusable`.

Expected binding:

- Reusable cancellation preserves the Diagnostic binding so a later basic turn on the same thread
  resumes.
- Non-reusable cancellation deletes/invalidates the binding so a later basic turn starts fresh.

Overlap canary:

1. Start one `diagnostic/hangs-until-cancel` turn for thread A and leave it open.
2. Start another turn for the same external agent kind and thread A.
3. Expected: HTTP 409 / server error, `TurnConcurrencyConflict`, and no `DriverStarted` for the
   overlapping turn.
4. Start a turn for thread B while thread A is still held.
5. Expected: thread B completes normally.

Known failure signatures:

- No `TurnCancelled` after closing the subagent means Codex did not disconnect the stream as
  expected or Caara missed the interrupt.
- `DriverStarted` for the same-thread overlap means the in-flight guard failed.
- Invalid `diagnostic_cancel` values must fail explicitly with `Unsupported diagnostic_cancel value`.

## Recovery

Goal: prove lost-continuity recovery uses Caara's standard final-answer prompt and updates binding.

Direct-provider sequence:

1. Seed the thread with `diagnostic/basic` and `metadata.cwd`.
2. Reuse the same Codex thread id with model `diagnostic/recovery`.

Failure variant:

- `?diagnostic_fresh_start=failure`

Expected Codex-visible output:

```text
I lost the external agent session context. Remind me, what did we discuss prior to this message, restate any relevant context and your request.
```

The recovery prompt must be an assistant message with `phase: "final_answer"`, not activity
commentary.

Expected relay logs:

- `LostSessionRecovered` with reason `diagnostic-unresumable-session`.
- Diagnostics include the previous Diagnostic cursor.
- `TurnCompleted` for successful recovery.
- `TurnFailed` for forced fresh-start failure.

Expected binding:

- Successful recovery writes cursor `{"sessionId":"diagnostic-session-recovered-codex-thread-diagnostic-basic"}`.
- Forced fresh-start failure preserves the old binding unchanged.

Known failure signatures:

- Recovery prompt as commentary means the lost-continuity UX contract regressed.
- Transport failure on successful fresh start means recovery was treated as unrecoverable.

## Echo

Goal: prove the driver receives only the current user turn input, not prior assistant/tool history.

Codex prompt:

```text
Run a Diagnostic echo smoke. Echo only the current user input summary.
```

Direct-provider model: `diagnostic/echo`.

First-turn input:

```json
[
  {
    "type": "message",
    "role": "user",
    "content": [{ "type": "input_text", "text": "first echo request" }]
  }
]
```

Follow-up input should include prior assistant/tool history plus a latest user message. Expected echo
must summarize only the latest user message.

Supported current-turn content:

- `input_text.text`
- `input_image.image_url`
- `input_file.file_path` or `input_file.path`

Expected Codex-visible output:

```text
Diagnostic echo current user input: [{"type":"input_text","text":"first echo request"}]
```

Expected relay logs:

- `TargetSelected` with `externalModelSpecifier: "echo"`.
- Runtime assistant final-answer lifecycle.
- `TurnCompleted` for supported content.
- `TurnFailed` for unsupported or malformed current-turn content.

Expected binding:

- Supported echo turns persist/update the Diagnostic durable cursor.
- Failed echo turns do not advance a successful binding.

Known failure signatures:

- Prior assistant output or tool output in the echo means current-turn input normalization regressed.
- Opaque `file_id`, unknown content types, or malformed content should fail explicitly rather than
  disappearing from the summary.
