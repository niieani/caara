# Unknown external-agent observations

## Brief

Implement PRD `CAARA-rrdbxhyf`: tolerate well-formed but unknown external-agent runtime/activity
observations without exposing raw payloads or weakening hard failures for malformed input,
unsupported options, process failures, append-only violations, or missing-final cases without a
diagnostic path.

## Goal

Caara treats provider runtime/activity observations as non-authoritative telemetry unless a mapped
shape is required for final turn semantics. Unknown observation rows/messages are ignored for
Responses-visible output, logged only with payload-safe diagnostics, and do not prevent later final
answers from completing the turn.

## Scope

In scope:

- ADR policy update superseding Antigravity unknown-shape hard-fail wording.
- Antigravity transcript observation tolerance for nonterminal rows like `MODEL/RUN_COMMAND/RUNNING`.
- Claude SDK regression coverage for unknown messages, content blocks, and stream delta/block shapes.
- Payload-safe telemetry: provider, shape, count, step/index, thread/turn correlation, payload
  length/hash only.

Out of scope:

- Relaxing malformed JSONL/SDK payload validation.
- Relaying raw unknown payloads as assistant text, raw Responses items, or logs.
- Driver option fallback behavior or request/input compatibility shims.

## Criteria

- `CAARA-lxzuvuhi`: ADR states unknown external-agent observations are non-fatal by default and
  names the superseded Antigravity ADR wording. Verify by doc review plus required slice checks.
- `CAARA-ildpwpkb`: Antigravity fixture/test proves `MODEL/RUN_COMMAND/RUNNING` is ignored with
  safe telemetry and final planner answer still emits. Verify focused Antigravity tests plus full
  suite per slice rule.
- `CAARA-buagqame`: Claude SDK tests prove unknown SDK observation shapes do not fail successful
  turns and do not leak raw payloads. Verify focused Claude tests plus full suite per slice rule.
- Final PRD review finds no blocking gaps. Verify independent subagent review before marking parent
  done.

## Execution

Sliced by fp child issues in dependency order. Each completed child gets its own commit, fp revision
assignment, and completion comment. Full validation runs before each child is marked done.
