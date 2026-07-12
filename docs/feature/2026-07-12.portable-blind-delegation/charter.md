# Portable Blind Delegation

## Brief

Implement `CAARA-mixhlklg` and every child issue in dependency order. Caara must expose durable,
transport-neutral Agent turns through CLI and MCP while keeping runtime activity available only to
a capability-protected human viewer. Responses remains supported through the same lifecycle seam.

## Final behavior

- Responses, CLI, and MCP adapters share one Agent Turn lifecycle implementation.
- CLI and MCP expose identifiers, coarse state, terminal failures, cancellation outcome, and final
  answer only; no runtime activity or observation-reading interface.
- A localhost capability viewer shows live and retained Agent runtime activity without disclosing
  session existence for invalid or expired capabilities.
- Portable sessions, turns, observation state, cancellation, restart recovery, retention, and
  concurrency have explicit durable contracts.
- Installed service, doctor, host guidance, Claude, Antigravity, and Codex-driver paths satisfy all
  child acceptance criteria.

## Boundaries

In scope: the PRD and its 14 existing child issues, linked ADRs/docs, tests, installation assets,
and user documentation. Out of scope: unrelated cleanup, remote multi-user authentication, and
experimental MCP Tasks unless strictly optional. Breaking internal changes preferred over duplicate
legacy lifecycle paths. No silent fallback for missing targets, identities, paths, or options.

## Principles

Transport-neutral domain seam; driver-owned options and opaque resume cursors; separate terminal
and observation projections; immutable terminal state; explicit IO seams; localhost-safe defaults;
TDD; project-native quality gates; atomic semantic commit per child issue.

## Criteria and verification

Each child issue's acceptance criteria are binding and verified by focused unit/integration tests,
then `bun run fmt:check`, `bun run lint`, `bun run typecheck`, `bun run test`, and applicable
`bun run build:service`/installed-service/smoke checks. Type tests run via `bun run test:types` when
contracts require them. Real-driver acceptance uses documented reproducible installed-service smoke
runs; unavailable credentials or executables are blockers, never silently skipped.

Completion additionally requires child completion comments, commit assignment, `done` status,
independent PRD review with no unresolved blocking findings, final PRD report, and PRD `done`.

## Read/write limits and execution shape

Read across the repository and bundled dependency references as needed. Write only PRD-related
source, tests, docs, generated-from-source artifacts, and this single workdesk. Never edit `.gen`
artifacts directly. Sliced execution follows fp dependencies; fp is issue-state source of truth.
Subagents review slices and the complete PRD but do not own fp transitions or commits.
