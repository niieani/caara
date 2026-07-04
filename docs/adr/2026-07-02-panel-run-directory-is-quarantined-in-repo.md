# Panel run directories are quarantined in-repo, relocated only by opt-in

Panel strategy runs stage deliberation artifacts in a repo-local `.panel/<run-id>/<seat-token>/`
directory, quarantined by ignore semantics rather than relocated outside the workspace. An
explicit `CAARA_PANEL_ROOT` opt-in moves the root outside the workspace (for example under
`$TMPDIR`) for maximum isolation; if the opt-in is set and a seat cannot write there, the run
fails loudly — there is no silent fallback.

The threat is contamination: cold-blind panelists exist to produce independent work, and agents
sharing a workspace reliably stumble on sibling output — observed in practice as one agent
discovering another's artifact in an adjacent directory and copying it instead of producing novel
work. But the observed discovery vectors are dirty `git status` and default search sweeps, and
both die with ignore semantics: an entry in `.git/info/exclude` (local-only, no tracked-file
mutation) hides the tree from `git status` and from ignore-respecting tools such as ripgrep, the
dot prefix hides it from plain listings, opaque per-seat tokens make sibling paths unguessable,
and cold-blind seats spawn in parallel so sibling artifacts barely exist during the window that
matters.

We first decided the opposite — always outside the workspace — and reversed it for portability:
common driver permission postures restrict writes to the workspace, and a skill whose every seat
fails its first write in cautious environments is dead on arrival. The tradeoff is deliberate:
perfect isolation becomes an informed opt-in, works-everywhere is the default. In-repo staging
also makes artifacts survive reboots, keeps paths workspace-relative for briefed seats, and opens
the door to in-project deliverables such as competing implementation variants in git worktrees
nested under the run root.
