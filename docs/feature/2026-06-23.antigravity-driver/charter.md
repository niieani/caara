# Antigravity Driver Charter

Implement `agy` as a first-class Caara driver selected by the `agy` external agent kind.

## Goal

Codex can create and continue Caara subagent turns backed by Antigravity CLI. Caara spawns one
`agy` process per turn, observes `transcript_full.jsonl`, maps validated transcript records into
driver-neutral runtime events, and persists only an opaque Antigravity resume cursor.

## Scope

In scope:

- Driver-owned option schema and argv contract.
- Fake `agy` integration seam for automated tests.
- Transcript JSONL parsing, validation, dedupe, append-only safety, and mapping.
- First turn, resumed turn, recovery, cancellation, and conservative binding reuse.
- Real `agy` smoke runbook plus evidence when available locally.

Out of scope:

- SQLite parsing.
- Raw transcript replay as session recovery.
- Resident Antigravity process.
- Interactive permission/question flows.
- Public endpoint hardening.

## Constraints

- Effect platform services for process/filesystem/path IO.
- No direct Bun process APIs in driver code.
- Opaque cursor is driver-owned versioned JSON with only conversation id for MVP.
- Transcript is observation surface only; stdout/log/DB never source Responses payloads.
- Fail closed on missing CLI evidence, malformed transcript, missing final model content, process
  failure, unsafe options, and ambiguous cancellation.

## Criteria

- `agy` routes through `AgentDriverRegistry`.
- Fake CLI tests cover first turn, required failure cases, options, resume, mapping, cancellation.
- Parser tests cover schema validation, newline buffering, duplicate/truncate handling, privacy.
- Session tests prove stored cursor and follow-up resume behavior.
- Smoke docs explain real `agy` validation and capture evidence or filed follow-up gaps.

## Verification

- Child-focused `bun run test <files> --run`.
- For every child before close: `bun lint`, `bun run test --run`, `bun run fmt`.
- Final parent: `bun run fmt`, `bun run typecheck`, `bun lint`, `bun run test --run`,
  `git diff --check`.
- Independent subagent review before parent done.

