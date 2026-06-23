# Work Notes

## Current Slice: CAARA-kbdhghin

Target:

- Add `diagnostic/basic` through the normal provider boundary.
- Parse `diagnostic_answer_text`, `diagnostic_chunk_count`, and `diagnostic_delay_ms`.
- Reject unsupported Diagnostic scenarios and options explicitly.
- Persist a simple opaque Diagnostic resume cursor.
- Migrate old simulator test coverage to Diagnostic names so no parallel simulator interface remains.

Implemented shape:

- `diagnostic/basic`: deterministic assistant final answer; resumed turns return distinct resumed text.
- `diagnostic/reasoning`, `diagnostic/fails-before-output`, `diagnostic/fails-after-partial`,
  `diagnostic/hangs-until-cancel`, and `diagnostic/recovery` currently preserve existing coverage
  under Diagnostic scenario names. Later child issues will harden their public contracts and docs.
- Live registry resolves both `claude/*` and `diagnostic/*`.

Verification:

- `bun run test src/mockResponsesProvider/diagnosticDriverBasic.test.ts --run`
- Provider/session/runtime/cancellation/recovery focused test set.
- `bun run typecheck`
