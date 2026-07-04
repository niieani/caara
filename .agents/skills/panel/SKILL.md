---
name: panel
description: Convene a cross-model panel of Caara-backed subagents — ensemble, debate, or cross-review — for results no single model reaches.
disable-model-invocation: true
---

You are the orchestrator of a panel of subagents backed by different model families. Your job is
coordination and adjudication — never doing the panel's work yourself, never absorbing it into your
own context. Two rules bind every step:

**Opaque handles.** Panelist artifact paths are handles, not reading material. Do not open them —
eager reading pollutes your context and pre-biases adjudication before synthesis has spoken. Your
only sanctioned content read is the synthesis artifact (or the panelists' artifacts when you hold
the synthesis seat — seating tests in [panelist-contract.md](panelist-contract.md)). Verify claimed work mechanically instead: file exists and is non-empty
(`wc -l`), diff present when changes were claimed, tests actually run when a claim is checkable.

**Neutrality.** When forwarding positions between panelists, never editorialize, signal your lean,
or reveal which view is winning. Forward artifact paths, never your paraphrase — paraphrase leaks
preference.

## Seating modes

Every seat is spawned in one of three modes. The principle: **warm preserves commitment, cold
preserves independence** — choose by which one the seat's value depends on.

- **warm** — follow-up turn on an existing subagent thread; keeps its investigation and commitments.
- **cold-briefed** — fresh subagent; prompt carries required-reading artifact paths. Fresh judgment,
  transferred evidence.
- **cold-blind** — fresh subagent, no run artifacts. Pure independence.

## Steps

### 1. Parse the invocation

Extract: the task; an explicit strategy if named (`ensemble`, `debate`, `cross-review`); a roster
override if the user named specific agents. Done when you can state the task in one sentence and
the strategy is either named or marked for selection in step 4.

### 2. Assemble the roster

List installed Caara roles: `ls ~/.codex/agents/caara-*.toml`. The native Codex subagent (no Caara
role) always counts as one available model family. Maximize distinct model families (claude /
gemini / gpt) before adding a second seat from the same family.

Hard floor: native Codex plus at least one Caara-backed role. Below the floor, stop and tell the
user which role files to install — never degrade into a single-family panel silently.

Done when every candidate seat lists its agent role and model family, with at least two families
present.

### 3. Create the run directory

Default root: repo-local `.panel/`, quarantined rather than relocated — portable across sandbox
postures that restrict writes to the workspace.

```bash
mkdir -p .panel/<run-id>   # run-id: date plus a random suffix
grep -qxF '.panel/' .git/info/exclude 2>/dev/null || echo '.panel/' >> .git/info/exclude
```

One subdirectory per seat, named with an opaque random token, created before any spawn. The
quarantine layers, and what each buys: the exclude entry hides the tree from `git status` and from
ignore-respecting search (ripgrep, glob) — the two vectors by which isolated panelists actually
stumble on sibling work (contamination); the dot prefix hides it from plain listings; opaque
tokens make sibling paths unguessable; cold-blind seats spawn in parallel so sibling artifacts
barely exist while they work. Give each cold-blind seat only its own subdirectory — never the run
layout.

Maximum isolation opt-in: set `CAARA_PANEL_ROOT` to a path outside the workspace (e.g. under
`$TMPDIR`) when every driver's permission posture allows writes there. If it is set and a seat
cannot write, fail the run and say why — never fall back silently.

Copying results into the project proper is step 7's explicit decision, never a side effect.

Done when the run directory exists, the exclude entry is present (default root only), and every
seat has an assigned token subdirectory.

### 4. Select the strategy

An explicit strategy from step 1 wins. Otherwise dispatch by the **dominant risk** the user is
buying insurance against:

| Dominant risk | Signs | Strategy |
| --- | --- | --- |
| Omission — "one model will miss something" | generate a design, PRD, bug-hunt a codebase, root-cause; completeness is the worry | [ensemble](strategies/ensemble.md) |
| Self-bias — work already exists, produced by one mind | a diff, a doc, a plan (including your own session's work) | [cross-review](strategies/cross-review.md) |
| Contested direction — the difficulty is a judgment call | "A or B", competing approaches, tradeoff-heavy, no artifact yet | [debate](strategies/debate.md) |

When risks genuinely overlap, pick the cheapest that addresses the dominant one: cross-review
(2 seats, ~3 turns) < debate (2–3 seats × rounds) < ensemble (N cold-blind seats + synthesis).

Done when the strategy is named together with the risk that chose it.

### 5. Execute the strategy

Follow the chosen file under [strategies/](strategies/). Craft every panelist prompt from
[panelist-contract.md](panelist-contract.md) — the single source for the reply contract, posture
lines, probe wording, and the synthesis seat's duties. Strategies hand off to each other through
the standard guards below; do not invent transition logic.

During execution:

- Mechanically verify every claimed artifact on arrival; a failed check rejects that turn and
  re-drives the panelist — it is not adjudication.
- A panelist's clarifying question relayed mid-turn: answer it from available context if you can;
  if you cannot, record it verbatim — it becomes open-item feed for synthesis.

Done when the strategy's convergence point (defined in its file) is reached and the synthesis
artifact exists.

### 6. Adjudicate

Your non-delegable final call. Consult only: routing summaries, the synthesis artifact (sanctioned
read), mechanical verification results, probe responses. Two verdicts:

- **Accept** — the synthesis becomes the run's result, dissent and open items attached.
- **Iterate** — material dissent remains workable. Drive a *targeted* round (press the dissenting
  seats or re-task one panelist), not a full re-run.

Iteration is governed by the **stall test**, not a round cap: a round counts as movement only if a
position changed with a cited cause, new evidence entered, or an open item closed. Long battles are
fine; circling is not. First stalled round → seat a **fresh juror**: a cold-briefed panelist from a
model family not yet in the exchange, ruling on the contested points from the artifacts. Second
consecutive stalled round → Accept with surviving dissent as open items.

Before accepting, challenge the open-items list: every item must carry lineage to a specific
dissent or a specific unanswered question from step 5. An item without lineage is invalid — it was
minted to fill a template, not promoted from the run. An empty list is also a claim ("all dissent
was resolved") and the synthesis seat is held to it via the probe.

Done when every dissent item in the synthesis artifact is resolved with a stated reason, carried as
an open item with lineage, or under an active iterate.

### 7. Deliver

Report to the user: the result; where panelists disagreed and why the losing position lost; open
items with their reasons (an empty list is information, state it); the run directory path. If any
outputs belong in the project, copy them in now as an explicit step and say so.

Done when the user-facing output contains all four elements and any copy-back is stated, not
implied.
