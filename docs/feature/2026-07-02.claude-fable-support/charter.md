# Claude Fable Support Charter

## Brief

Expose Claude Fable 5 as a Caara Claude target if implementation already accepts it; otherwise add
missing support.

## Goal

Caara users can select Claude Code Fable through the Responses model string `claude/fable`, and
docs make clear that Caara passes Claude model suffixes through to the Claude Agent SDK.

## Scope

Read/write limits:

- `.codex/agents/*`
- `README.md`
- `docs/caara.md`
- `docs/agents/smoke-testing.md`
- `package.json`
- `bun.lock`
- this workdesk

No Caara core model allow-list. Existing ADRs require model suffixes to stay driver-owned and
opaque.

## Criteria And Verification

- `claude/fable` is documented as a supported Claude target; verify by `rg`.
- A checked-in Codex role can target Fable without replacing the cheap Claude smoke role; verify by
  TOML review and `rg`.
- Docs mention Claude Code Fable requirements and availability constraints from official docs; verify
  by source review.
- Claude Agent SDK dependency is current if the lockfile change is limited and compatible; verify by
  `bun pm view`, `bun install`, and focused Claude SDK tests.
- Formatting remains stable; verify with `bun run fmt:check`.

## External Evidence

- Claude Code model config: Fable selected as `/model fable`; requires Claude Code `v2.1.170+`.
- Claude models overview: Claude Fable 5 API ID `claude-fable-5`; generally available June 9,
  2026; not all accounts/providers have equivalent availability.

