# Agent Smoke Roles Charter

## Brief

Rename the Claude-backed Codex role from `caara` to `caara-claude`, add an Antigravity-backed
Codex role, and correct Antigravity smoke docs to use Codex subagent testing.

## Goal

Codex can spawn both real Caara-backed smoke agents:

- `agent_type = "caara-claude"` routes to `model = "claude/haiku"`.
- `agent_type = "caara-antigravity"` routes to `model = "agy/gemini-3.5-flash"`.

The Antigravity runbook mirrors the Codex subagent first-turn/resume/cancel pattern from
`docs/agents/smoke-testing.md`; direct HTTP or direct `agy` calls are not accepted as substitutes.

## Scope

Read/write limits:

- `.codex/agents/*`
- `README.md`
- `docs/agents/*smoke*`
- `docs/caara.md`
- this workdesk

No source-code changes; the existing `agy/*` driver routing is already present.

## Criteria And Verification

- Claude role file is `.codex/agents/caara-claude.toml`, has `name = "caara-claude"`, and pins
  `model = "claude/haiku"`; verify by file review and `rg`.
- Antigravity role file is `.codex/agents/caara-antigravity.toml`, has
  `name = "caara-antigravity"`, and pins `model = "agy/gemini-3.5-flash"`; verify by file review
  and `rg`.
- Live smoke docs refer to `caara-claude` and `caara-antigravity`, not the retired generic
  `caara` role; verify by `rg`.
- README lists the current supported target prefixes and role files; verify by file review.
- Antigravity runbook uses Codex subagent spawn, same-handle resume, relay evidence, and
  cancellation checks; verify by doc review.
- Markdown/TOML formatting remains parseable; verify with `bun run fmt:check`.
