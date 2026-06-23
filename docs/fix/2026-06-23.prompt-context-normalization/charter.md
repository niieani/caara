# Prompt Context Normalization Charter

## Brief

Implement `CAARA-blmtwbcl` and all child issues. Real Codex-path Antigravity smoke failed because
Caara sent raw mixed Responses input toward drivers instead of a normalized current user request.

## Goal

Caara core normalizes incoming Codex Responses input before driver dispatch. Drivers receive only the
actual current managing-agent user request, while developer messages and Codex AGENTS/environment
prelude context are ignored. Both Claude and Antigravity real Codex-path smokes pass.

## Scope

In scope:

- `src/mockResponsesProvider` transport/driver boundary types and tests.
- `src/antigravityCliDriver` and `src/claudeAgentSdkDriver` prompt tests/adapters.
- Durable docs explaining why prelude context is ignored.
- fp child issues under `CAARA-blmtwbcl`, comments, status, and commits.

Out of scope:

- Replacing external agent SDK/CLI integration.
- Direct `/v1/responses` smoke as primary acceptance.
- Branch changes or pushes.

## Criteria And Verification

- `CAARA-wxuwzhzt`: shared core normalization exists before driver dispatch, has pure tests for
  real Codex shape, and docs explain the external-agent-native context rationale. Verify with
  focused test, full test suite, lint, fmt, commit, fp comment/status.
- `CAARA-sqziymmp`: Antigravity consumes normalized input and fake-`agy` provider-boundary test
  proves no developer/AGENTS/env leak. Verify focused Antigravity tests plus slice gates.
- `CAARA-htpltnlq`: Claude consumes normalized input and regression tests prove no developer/AGENTS/env
  leak. Verify focused Claude tests plus slice gates.
- `CAARA-kaaocpat`: real Codex-path `caara-claude` and `caara-antigravity` smokes pass or exact
  environment blocker/remediation siblings are recorded. Verify live provider logs and subagent
  responses.

## Execution Shape

TDD by fp child issue in dependency order. Each completed child gets an atomic semantic commit and
issue assignment. Final PRD review subagent required before closing parent.
