# Work Notes

## Current Slice: CAARA-uagzirfk

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
