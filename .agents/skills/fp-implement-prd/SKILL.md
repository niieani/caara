---
name: fp-implement-prd
description: Implement an fp PRD issue and its child issues to completion.
disable-model-invocation: true
---

# FP Implement PRD

Implement one fp PRD and every child issue beneath it. Treat fp as the source of truth: issue status replaces plan checkboxes, and issue comments replace plan reports.

## Argument

Collect every unique `JUL-...` issue id in the user's message, preserving order.

- If no id is present, ask for one and stop.
- If one id is present, implement that PRD exactly as below.
- If multiple ids are present, treat them as a sequential PRD execution queue.
- Validate every supplied id before editing: it must be a top-level PRD issue. If any id is not a PRD parent issue, stop and report the invalid id.
- Execute PRDs in the exact order supplied by the user. Do not reorder based on apparent dependencies unless the user explicitly asks.

## Multiple PRDs

When multiple PRD ids are supplied:

1. Do not mark all PRDs `in-progress` up front. Work only the current PRD.
2. Complete the full workflow for the current PRD, including child issue commits, final PRD verification, final PRD comment, and marking the PRD `done`.
3. Only after the current PRD is `done`, move to the next PRD in the queue.
4. If the current PRD is blocked, add the blocker comment required by this skill and stop the whole queue. Do not skip ahead unless the user explicitly asks.
5. Before starting each PRD, check its fp dependencies if present. If any dependency is not `done`, stop and report the missing dependency.
6. Keep each child issue atomic: do not batch commits across child issues or across PRDs.

## Workflow

For each PRD id being executed:

1. Load context:
   - `fp context <prd-id>`
   - `fp tree <prd-id>`
   - `fp guide implement`
2. Use `$builder-workflow` for the PRD and for each child issue.
3. Mark the PRD issue `in-progress` and add a short start comment.
4. Read every child issue before editing code.
5. Work child issues in dependency order. Only start a child issue when all dependencies are `done`.
6. For each child issue:
   - run `fp context <issue-id>`;
   - mark it `in-progress`;
   - add a start comment naming the first implementation step;
   - write focused red tests first;
   - implement until focused validation passes;
   - apply the Slice Completion Rules;
   - add a completion report with `fp comment`;
   - mark the issue `done`;
   - create an atomic semantic commit mentioning the issue id.
7. After all child issues are `done`, re-read the PRD and verify every acceptance-relevant requirement is satisfied.
8. Add a final PRD report comment, mark the PRD `done`, and create a final semantic commit if any final verification/docs changes were made.

Completion criterion: the PRD and every child issue are `done`, dependency order was respected, each child has a completion report comment, and every completed child has an atomic commit.

As you work, run lint/typecheck and focused tests for the changed storage/runtime/operator area to save time.
Full test suite only before making the marking the child issue `done` to verify integration and catch any missed edge cases.

## Slice Completion Rules

Apply these before marking each child issue `done`:

1. Run `bun lint`.
2. Run `bun run test --run`
3. Run `bun run fmt`.
4. Commit the completed issue with a semantic commit message that mentions the issue id.
5. Run `fp issue assign <issue-id> --rev <comma-separated-revs-to-add>` to link the issue to the commit.
6. Add an `fp comment <issue-id>` report with:
   - behavior implemented;
   - verification commands run;
   - notable test, artifact, or log examples;
   - deviations from the issue or PRD, with reasoning.

## Blockers

Do not mark an issue `done` unless its acceptance criteria are satisfied. If blocked, comment with the exact blocker and leave the issue not done. Move only to another unblocked child if doing so is safe and does not violate dependencies.
