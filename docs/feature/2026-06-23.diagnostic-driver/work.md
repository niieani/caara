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

## Completed Slice: CAARA-dscficym

Target:

- Keep `diagnostic/hangs-until-cancel` in flight until client disconnect/cancellation.
- Support bounded `diagnostic_cancel` values for interrupted reusable, abandoned reusable,
  abandoned non-reusable, and terminated non-reusable outcomes.
- Preserve the turn-concurrency canary: same session key conflicts, independent thread proceeds.

Implemented shape:

- `diagnostic/hangs-until-cancel` uses the normal infinite runtime stream and cancel callback.
- Cancellation tests now assert every supported outcome mapping, explicit failure for unsupported
  `diagnostic_cancel` values, reusable resume behavior, non-reusable fresh-start behavior, and relay
  cancellation records.
- Concurrency test asserts a held-open Diagnostic turn blocks same-thread overlap before driver
  start while another Codex thread completes normally.

Verification:

- `bun run test src/mockResponsesProvider/turnCancellation.test.ts src/mockResponsesProvider/turnConcurrency.test.ts --run`

## Completed Slice: CAARA-zpdpednf

Target:

- Exercise Caara's standard lost-continuity recovery prompt with `diagnostic/recovery`.
- Treat successful fresh-session recovery as a final answer, not activity commentary or transport
  failure.
- Preserve the old binding when the fresh recovery session cannot start.

Implemented shape:

- Diagnostic recovery returns Caara-owned `lostSessionRecoveryAssistantText`, records
  `LostSessionRecovered`, and writes a fresh Diagnostic resume cursor.
- Recovery runtime events now explicitly mark the prompt message as `phase: "final_answer"`.
- Failure option `diagnostic_fresh_start=failure` returns OpenAI-shaped failure and preserves the
  original binding for inspection.

Verification:

- `bun run test src/mockResponsesProvider/sessionRecovery.test.ts --run`

## Completed Slice: CAARA-yxinmtvr

Target:

- Write Codex-agent-facing runbooks for every v1 Diagnostic scenario.
- Include setup, model specifier, query params, prompt shape, expected visible output, relay logs,
  binding effects, and failure signatures.
- Link the runbooks from the existing smoke-testing docs without removing Claude SDK smoke flow.

Implemented shape:

- Added `docs/agents/diagnostic-smoke-runbooks.md` with common setup, Diagnostic-vs-Claude
  distinction, direct-provider fallback shape, and scenario sections for basic, reasoning,
  activity, failure, cancellation/concurrency, recovery, and echo.
- `docs/agents/smoke-testing.md` now points Caara-core smokes at the Diagnostic runbooks while
  retaining the Claude SDK subagent flow.

Verification:

- `bun run fmt`

## Completed Slice: CAARA-plzewqhc

Target:

- Run the Diagnostic smoke suite and capture evidence for all v1 scenarios.
- Include commands/config, Codex-visible output, relay logs, session binding effects,
  cancellation/concurrency behavior, Diagnostic-vs-Claude distinction, and current Codex-path gaps.

Implemented shape:

- Ran a real local provider with isolated `CAARA_STATE_DIR`.
- Exercised all v1 Diagnostic scenarios via Codex-shaped direct HTTP requests.
- Captured JSON summary, provider relay log, and state directory under
  `temp.local/2026-06-23/diagnostic-smoke/`.
- Added committed summary in `smoke-evidence.md`.
- Recorded Codex-path blocker: current thread exposes only the Claude-backed `caara` role.
  Follow-up issue: CAARA-feujtevl.

Verification:

- `bun run temp.local/2026-06-23/diagnostic-smoke/run-diagnostic-smoke.ts`
