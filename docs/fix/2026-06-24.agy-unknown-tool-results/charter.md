# Agy unknown tool results

Brief: Hegel turn failed with `response.failed` because Antigravity emitted
`MODEL/GENERIC/DONE` for a `manage_task` tool result.

Goal: unknown Antigravity model result rows do not fail the Responses stream. Caara logs a warning
with the unknown transcript shape, ignores the raw result payload, and continues waiting for a final
planner response.

In scope:

- Antigravity transcript validation.
- Regression coverage for `MODEL/GENERIC/DONE`.
- Provider restart after validation.

Out of scope:

- Rendering raw unknown tool outputs.
- Treating unknown tool results as final answers.
- Broad Antigravity protocol redesign.

Criteria:

- `MODEL/GENERIC/DONE` with content decodes without failing. Verifier:
  `src/antigravityCliDriver/transcript.test.ts`.
- Raw unknown result content is not relayed as visible assistant text. Verifier: same focused test.
- Unknown non-result transcript shapes still fail explicitly. Verifier: existing malformed/unknown
  shape test.
- Ignored model result rows emit structured provider warning logs. Verifier: code review plus tmux
  log inspection after a matching turn.
- Existing activity formatting behavior remains green. Verifier: focused Antigravity/Claude tests.

Execution: small TDD fix; restart `caara-agy-smoke` after validation.
