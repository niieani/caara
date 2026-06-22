# Codex Request Diagnostics

## Brief

Instrument the current Caara Responses-compatible endpoint before smoke testing through Codex subagent wiring.

## Goal

When Codex calls Caara, the provider logs enough request metadata to identify session-stability inputs and working-directory hints needed for future driver spawning.

## Scope

In scope:

- `POST /v1/responses` request diagnostics.
- Full JSON request body capture.
- Selected request metadata: method, URL, redacted headers.
- Best-effort cwd candidate extraction from request JSON.
- Focused test for diagnostics capture.
- Manual smoke run through current Codex subagent path where available.

Out of scope:

- Claude Code driver implementation.
- Durable session directory.
- Route/profile configuration.
- Public docs rename from mock/provider language.

## Criteria

- Diagnostics include full request body.
  - Verify: focused Vitest integration test.
- Sensitive headers are redacted.
  - Verify: focused Vitest integration test.
- Cwd-like JSON fields are surfaced as candidates.
  - Verify: focused Vitest integration test.
- Current mock stream behavior remains unchanged.
  - Verify: existing focused test.
- Smoke captures real Codex request diagnostics.
  - Verify: local server log artifact, or report unavailable subagent tooling.
