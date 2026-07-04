# $panel

A Codex skill that convenes a cross-model panel of Caara-backed subagents. Different model families
have different blind spots; the panel runs one of three strategies — **ensemble** (isolated
attempts, synthesized), **debate** (committed positions arguing to consensus), **cross-review**
(one family produces, another reviews) — to reach results no single model does.

Part of the Caara skill pack: the Caara service is unaware of it; the skill is a demonstration of
what Caara-backed subagents make possible.

## Prerequisites

- The Caara user service installed and running (`caara` on localhost).
- At least one Caara agent role installed in `~/.codex/agents/` (`caara-claude`,
  `caara-antigravity`, …) — the Caara installer configures these. The panel needs native Codex
  plus at least one external family; more families, stronger panels.
- Panel runs stage artifacts in a quarantined repo-local `.panel/` directory by default, so no
  special permissions are needed. For maximum isolation, set `CAARA_PANEL_ROOT` to a path outside
  the workspace (e.g. under `$TMPDIR`) — only after smoke-checking that every driver's permission
  posture allows writes there (spawn a subagent, have it write a file at that root, confirm it
  lands). A configured external root that a seat cannot write to fails the run; there is no silent
  fallback.
- For panelists to invoke named skills, all harnesses must see the same skill directory: keep
  `.claude/skills` symlinked to `.agents/skills` (or symlink the individual skills).

## Invocation

```text
$panel <task>                      # strategy selected by dominant risk
$panel debate: <task>              # explicit strategy
$panel ensemble: <task> using claude and agy   # explicit roster
```

Examples:

```text
$panel review the diff on this branch
$panel ensemble: draft a PRD for the session-recovery feature
$panel debate: should driver options be per-turn or per-binding?
$panel ensemble: build a marketing site for this project   # code variants: worktree per attempt,
                                                           # judged by running, branches kept
```

## Cost expectations

A panel run costs a multiple of a single-agent run (ensemble: roughly seats × task cost, plus
synthesis). Invoke it where the failure it insures against is expensive: work about to be
committed, decisions that are hard to reverse, documents whose omissions surface late.

## Design

The coordination protocol (opaque handles, routing summaries, stall test, open-item lineage,
sycophancy countermeasures) came out of a grilled design session; vocabulary lives in the Caara
repo's `CONTEXT.md` (Skill Pack Language) and the two load-bearing decisions are recorded as ADRs:
`docs/adr/2026-07-02-panel-run-directory-is-quarantined-in-repo.md` and
`docs/adr/2026-07-02-panel-orchestrator-adjudicates-without-reading.md`.
