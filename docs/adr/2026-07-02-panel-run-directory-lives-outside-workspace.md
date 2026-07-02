# Panel run directories live outside the workspace

Panel strategy runs stage deliberation artifacts in a run directory under the system temp location
(`$TMPDIR/caara-panel/<run-id>/<seat>/`), never inside the project workspace — a deliberate
deviation from this repo's usual `temp.local/<date>/` staging convention. Do not "fix" this back:
the deviation is the point.

The reason is contamination. Cold-blind panelists exist to produce independent work, and agents
that share a workspace reliably stumble on sibling output — observed in practice as one agent
discovering another's artifact in an adjacent directory and copying it instead of producing novel
work. Independence is the entire value of ensemble openings and initial debate positions, so the
staging area must sit where workspace exploration cannot reach it. The orchestrator owns the run
directory layout and assigns each seat its own subdirectory; copying results back into the project
afterwards is an optional, explicit orchestrator step, never a side effect.

Consequences: outputs that must live in the project to be exercised (for example competing variants
of a component or API that need to typecheck in place) are out of scope for the v1 skill pack;
prompt guards or git worktrees are the likely future answer. Driver permission postures must allow
writes outside the workspace — smoke-verified for the currently installed drivers on 2026-07-02.
