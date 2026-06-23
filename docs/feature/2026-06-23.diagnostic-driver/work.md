# Work Notes

## Completed Slice: CAARA-uagzirfk

Target:

- Add `diagnostic/activity` through the normal provider boundary.
- Emit terse assistant commentary messages with `phase: "commentary"`, never tool-call/custom/raw
  Responses items.
- Add bounded `diagnostic_activity=off` opt-out that keeps activity runtime/relay records but hides
  commentary from Codex-visible SSE.
- Preserve final answer completion with `phase: "final_answer"`.

Implemented shape:

- `diagnostic/basic`: deterministic assistant final answer; resumed turns return distinct resumed text.
- `diagnostic/activity`: two milestone commentary messages plus deterministic final answer.
- `diagnostic/reasoning`, `diagnostic/fails-before-output`, `diagnostic/fails-after-partial`,
  `diagnostic/hangs-until-cancel`, and `diagnostic/recovery` currently preserve existing coverage
  under Diagnostic scenario names. Later child issues will harden their public contracts and docs.
- Live registry resolves both `claude/*` and `diagnostic/*`.

Verification:

- `bun run test src/mockResponsesProvider/diagnosticDriverBasic.test.ts --run`
- `bun run test src/mockResponsesProvider/diagnosticDriverActivity.test.ts --run`
- Provider/session/runtime/cancellation/recovery focused test set.
- `bun run typecheck`

## Completed Slice: CAARA-whnkibft

Target:

- Add `diagnostic/echo` as a deterministic current-turn input inspection scenario.
- Summarize only the latest user message content seen by the Diagnostic driver.
- Ignore prior assistant output, prior tool output, and other history when a follow-up request
  includes the full Responses transcript.
- Fail explicitly for unsupported or malformed current-turn content.

Implemented shape:

- `diagnostic/echo` emits a final assistant answer with a JSON-stable summary of supported
  `input_text`, `input_image.image_url`, and `input_file.file_path` / `input_file.path` content.
- Opaque `file_id` and unsupported current-turn content fail through the normal Diagnostic driver
  error path.

Verification:

- `bun run test src/mockResponsesProvider/diagnosticDriverEcho.test.ts --run`

## Completed Slice: CAARA-vioqooox

Target:

- Keep `diagnostic/reasoning` on the runtime reasoning lifecycle, not assistant commentary.
- Verify ordering from reasoning item lifecycle through final assistant answer and terminal success.
- Verify successful reasoning turns persist the Diagnostic session binding.

Implemented shape:

- Existing Diagnostic runtime stream emits `reasoning` item events followed by final assistant text.
- Provider-boundary test now asserts reasoning SSE delta, runtime event ordering, final completion,
  relay target selection, and persisted Diagnostic binding cursor.

Verification:

- `bun run test src/mockResponsesProvider/mockResponsesProvider.test.ts --run`

## Completed Slice: CAARA-canilqfh

Target:

- Expose `diagnostic/fails-before-output` and `diagnostic/fails-after-partial`.
- Verify both scenarios fail terminally through OpenAI-shaped Responses behavior.
- Preserve session binding safety: no binding on startup/runtime failure before output; no binding
  advancement after partial output failure.

Implemented shape:

- Existing Diagnostic scenario routing emits a driver failure before runtime output or after a
  partial reasoning summary.
- `runtimeFailure.test.ts` asserts `response.failed`, absence of `response.completed`, binding
  absence/preservation, recovery after failure, and `TurnFailed` relay records with Diagnostic
  messages.

Verification:

- `bun run test src/mockResponsesProvider/runtimeFailure.test.ts --run`
