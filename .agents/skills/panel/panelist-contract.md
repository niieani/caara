# Panelist Contract

The single source for everything that goes *into* panelist prompts. Every strategy composes its
prompts from these blocks; nothing here is optional unless marked so.

## Every panelist prompt contains

1. **The task slice** — what this seat must do. Two composition modes when the task involves an
   existing skill: instruct the panelist to invoke it by name ("invoke /code-review on …" — all
   harnesses read `.agents/skills/`), or extract only the relevant part of the skill into a bespoke
   prompt when the seat's role needs a slice, not the whole. Choose per seat; say which you chose
   only if the user asks.
2. **The exact output path** — assigned by you, inside the seat's run-directory subdirectory, with
   a filename encoding round and purpose (`r01-position.md`, `r02-response.md`, `findings.md`).
   Never let a panelist choose its own path.
3. **Required reading** (cold-briefed and warm rounds only) — the artifact paths this seat must
   read in full. Paths, never pasted content, never your paraphrase.
4. **The reply contract** (below).
5. **The posture block** (below).

## Reply contract

The panelist's reply to you is exactly:

```text
artifact_path=<path>
summary=<max 40 words>
status=done|blocked
```

The summary is routing metadata only — never evidence, never forwarded to another panelist, never
a substitute for the artifact. Downstream prompts cite artifact paths as required reading;
forwarding a summary invites the reader to skip the artifact and reason from the paraphrase.

## Posture block

Panelists treat their orchestrator as a user and will capitulate to please it. Counter this in
every prompt that takes or defends a position; include these instructions:

- Defend your position until presented with evidence or an argument that would genuinely change
  your mind — and state that condition explicitly ("I would concede if X").
- If you concede a point, name the specific argument or evidence that changed your mind. An
  unexplained reversal will be treated as capitulation and discarded.
- Agreement is not a courtesy. If you agree, demonstrate why the position survives your strongest
  objection.

A concession that names no cause does not count as movement (stall test, SKILL.md step 6) — flag
it and probe.

## Anti-laziness probe

Press any panelist that fully agrees, approves without findings, or raises nothing within its
first two turns. The press:

```text
Before I accept this, confirm:
1. You read the entire <artifact/document> — list at least 3 specific sections you engaged with.
2. Why is it complete — what would be missing if it were wrong?
3. Any remaining concerns, however minor.
```

A hollow response to the probe rejects the turn; re-drive or re-seat.

## Synthesis seat

Spawn per the seating tests (SKILL.md step 6 context: cold-briefed subagent by default; you
synthesize inline only when the run is terminal *and* inputs are small; seat a strong-prose family
when the deliverable's quality is prose-sensitive). The synthesis prompt requires:

- Read every listed artifact in full. Summaries are not inputs; you have none.
- Consolidate the correct reasoning — do not average positions or split differences. Where
  panelists conflict, decide from the evidence in the artifacts, and verify any cheaply checkable
  claim (run the test, run the typecheck) instead of judging confidence.
- Write a **dissent section**: every disagreement encountered, and for each, either how the
  evidence resolved it or why it survives.
- Mint **open items** only from two sources: (a) a surviving dissent whose stated concede-condition
  could not be tested within this run — cite whose positions and which condition; (b) a relayed
  question the orchestrator could not answer — quote it verbatim. Most runs end with zero open
  items. An empty list is a claim that all dissent was resolved, and you will be held to it. An
  item without lineage to a specific dissent or question is invalid.
- Output: the synthesis artifact at the assigned path, plus the standard reply contract.
