# Ensemble

Dominant risk: **omission** — insurance against any single model's blind spots. Isolated attempts
at the same task, then consolidation.

## Seats

| Seat | Count | Mode | Family rule |
| --- | --- | --- | --- |
| attempt | 3 (min 2 if roster is thin) | cold-blind | one per model family before any repeat |
| synthesis | 1 | cold-briefed | per the seating tests |

## Flow

1. **Fan out.** Send the same task verbatim to every attempt seat, in parallel (distinct
   subagents). Each prompt assigns that seat's own output path. Do not mention that other attempts
   exist — the expectation of comparison contaminates as surely as shared files. Independence is
   this strategy's entire value.
2. **Verify.** Mechanically check each artifact on arrival; re-drive failed seats.
3. **Synthesize.** Seat synthesis per the [contract](../panelist-contract.md), listing all attempt
   artifacts as required reading.
4. **Adjudicate** (SKILL.md step 6). Material dissent between attempts is workable: iterate as a
   debate between the disagreeing seats — warm, since they must own the positions their artifacts
   took — following [debate](debate.md) from its Rounds step. Ensemble is debate with a cold-blind
   opening.

## Code variants

When the deliverable is code, an attempt seat's artifact is an implementation, not a document.
Documents stay on plain artifacts — this section adds machinery only where code needs it. Pick the
data plane by scope:

- **Leaf scope** — self-contained files (a component, a single module) built against the
  project's *existing* dependencies: attempt seats write into their artifact directories as usual,
  no worktrees. A variant that needs a new dependency or a config change must declare it in its
  artifact instead of assuming it — that declaration escalates the variant to feature scope for
  judging.
- **Feature scope** — anything that must live at real project paths to build (a website, a
  monorepo package), or a leaf variant that escalated: each attempt seat gets a nested git
  worktree under the run root, on branch `panel/<run-id>/<token>`, created and made ready by a
  **prep seat** — a native Codex subagent invoking `$worktree-setup` — so the orchestrator's
  context stays clean. Attempts start from a green baseline; a seat that receives a broken
  worktree was failed by the prep seat, not the task.

Judging replaces the synthesis reading rule: the judge **runs** each variant before writing
anything, and visual deliverables get a **gallery** — side-by-side or behind a 1/2/3 switcher — in
one of two forms, selected mechanically by what the variants touched (`git diff --stat` against
base, or the leaf declarations):

- **Copy gallery** — every variant left manifests and config untouched (no `package.json`,
  lockfile, or tool-config changes): copy the variants into one scratch route or page in project
  context, one dev server, cheapest comparison.
- **Served gallery** — any variant touched dependencies or config: never merge incompatible
  worlds into one checkout. The prep seat boots each variant in its own worktree on its own port,
  and the gallery is a static compare page iframing each port behind the switcher (plain links as
  fallback — some dev servers refuse frames). The judge and the user get the same URL list.

Backends: judge on code quality and the test suite; execute only when variants' state is isolated
(ports, databases). Findings cite what was run, not what was read.

Verdict and composition: pick one variant, or compose — the composer (usually the judge, warm)
merges the winning parts into `panel/<run-id>/final`. Either way every variant branch is kept and
its name reported: the deliverable stays human-judgeable, and the user may overrule the judge.

Hard rule: if the task depends on uncommitted workspace changes, stop and say "commit or stash
first" — worktrees check out committed state only.

## Convergence point

The synthesis artifact lands — or, for code variants, the judge's verdict artifact plus the kept
variant branches.
