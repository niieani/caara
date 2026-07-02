# Claude executable resolution

## Brief

Fix the Claude SDK driver startup failure observed in Codex subagent smoke: SDK could not find its bundled native CLI from the compiled Caara service. Separate error-reporting bug is delegated to thread `019f21bb-cdfc-7621-97ce-80140f975f16`.

## Goal

Claude turns use Caara's service execution path to resolve the `claude` executable and pass the absolute executable path to Claude Agent SDK `pathToClaudeCodeExecutable`.

## Scope

In scope: Claude SDK driver settings/options wiring, focused regression tests, minimal docs if contract changes.

Out of scope: Codex-visible `TurnFailed` surfacing, Claude SDK package upgrade, service installer behavior.

## Criteria

- Claude SDK query options include `pathToClaudeCodeExecutable` when the driver starts a turn. Verifier: focused Claude driver test.
- Direct options builder preserves the provided executable path. Verifier: focused Claude option test.
- Existing permission/path option behavior remains unchanged. Verifier: focused Claude permission policy test.
- No legacy fallback to SDK bundled binary for Caara live driver. Verifier: code review and focused tests.
