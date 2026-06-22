# Smoke Evidence

Artifact: `temp.local/2026-06-21/caara-smoke.log`

## Result

Real `agent_type = "caara"` smoke passed.

- First smoke response: `Yes, the mock subagent seems to be working`
- Second smoke response, first turn: `Yes, the mock subagent seems to be working`
- Second smoke response, follow-up turn: `Yes, the mock subagent seems to be working`

## Codex Request Shape

Stable subagent key appears to be `thread-id` / `client_metadata.thread_id`.

- New subagent: new `thread-id`
- Follow-up turn on same subagent: same `thread-id`
- Each turn: new `turn_id`
- Parent managing Codex session: `session-id` / `x-codex-parent-thread-id`

Working directory signal:

- First turn `x-codex-turn-metadata.workspaces` includes `/Volumes/Projects/Software/code-agents-as-responses-api`.
- Follow-up turn omitted `workspaces`, but body context still included cwd and diagnostics extracted the same path.

Implication:

- Caara session directory should key external agent sessions by Codex `thread_id`.
- Driver spawn cwd can use first available workspace path from `x-codex-turn-metadata.workspaces`, falling back to extracted body cwd context.
