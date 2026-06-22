# Claude Code driver for Caara v1

## Brief

Implement fp PRD `CAARA-mckrjcuh` and every child issue beneath it.

Caara must keep Codex-facing `/v1/responses` transport, decode Codex turn identity at the boundary,
route `claude/<external-model>` targets through a driver seam, persist durable session bindings, and
prove simulator plus real Claude Code behavior.

## Scope

In scope:

- Codex turn context + agent target validation.
- Claude simulator driver for deterministic transport/session tests.
- Durable session directory keyed by external agent kind and Codex thread id.
- One in-flight turn per session binding.
- Client disconnect cancellation, abandonment, and recovery policies.
- Real Claude Code invocation/resume/cancel contract and driver path.
- Codex smoke evidence and user-facing configuration docs.

Out of scope:

- External agent kinds other than Claude Code.
- Ephemeral driver support.
- Transcript persistence/replay.
- Queueing overlapping turns.
- Production auth/hosting.

## Constraints

- Use Bun + TypeScript + Effect v4.
- Test-first for every child issue.
- Effect Schema validates untrusted headers/body/query metadata before driver logic.
- Driver options stay raw and driver-owned until the selected driver validates them.
- Missing non-optional identity or cwd fails explicitly.
- Session directory stores resume metadata only.

## Verification

- Focused Vitest files during implementation.
- `bun lint`, `bun run test --run`, `bun run fmt` before every child issue is marked done.
- Typecheck whenever TypeScript surface changes materially.
- Claude contract proof through isolated harness/evidence before real driver wiring.
- Final Codex smoke with `model = "claude/haiku"` or documented cheapest Haiku target.

