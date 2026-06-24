# Antigravity transcript resilience

Brief: implement fp PRD `CAARA-lrpejere` and children for hardening Antigravity transcript mapping
after a Hegel Agy turn failed on an unknown `MODEL/GENERIC/DONE` row.

Goal: Antigravity transcript protocol drift becomes observable, testable, and diagnosable without
raw payload leakage or opaque Responses stream disconnects where a deliberate diagnostic is possible.

Subject:

- `src/antigravityCliDriver/transcript*.ts`
- Antigravity driver fake fixtures/tests
- Remediation docs and fp issue reports

In scope:

- redacted replay fixtures for real transcript shapes
- ignored-row warning telemetry with safe correlation metadata
- deliberate final-less tool-only turn behavior
- robust handling of out-of-order `step_index` rows
- focused and integration validation for the Antigravity mapper/driver path

Out of scope:

- rendering raw unknown tool outputs
- using Antigravity SQLite databases as integration input
- changing Claude driver behavior
- changing Codex Responses protocol semantics outside the driver-neutral runtime contract

Principles:

- Preserve transcript payload privacy: raw tool output, file content, and unknown row content must
  not appear in visible assistant text or provider warning logs.
- Keep transcript validation explicit for unsupported non-result shapes.
- Prefer fixture replay over brittle assumptions about upstream Antigravity row order.
- Keep each fp child atomic and committed separately.

Criteria and verification:

- Real-shape replay fixtures cover unknown model result rows and out-of-order step indexes.
  Verifier: focused transcript fixture test.
- Ignored rows log structured warning telemetry by shape with thread/turn where available, step
  index, content length, and content hash; raw content redacted. Verifier: focused log assertion.
- Final-less tool-only turns produce explicit, stable diagnostic behavior and provider logs instead
  of an undifferentiated missing-final failure. Verifier: unit and fake-driver integration tests.
- Transcript runtime mapping is stable for out-of-order rows and preserves append-only rewrite
  detection. Verifier: fixture replay plus existing truncation tests.
- Full PRD closure requires every child issue `done`, child completion comments, atomic commits, and
  independent PRD review with no blocking findings.

Execution shape: sliced PRD implementation with fp status/comments as source of truth. Run focused
tests during each slice, `bun lint`, `bun run test --run`, and `bun run fmt` before marking each
child done.
