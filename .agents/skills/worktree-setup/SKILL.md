---
name: worktree-setup
description: Create a ready-to-work git worktree — branch, deps, local config, green build — and report it.
disable-model-invocation: true
---

Make a git worktree another agent can start working in immediately, without stumbling over missing
dependencies or config. Invoked with a target path and branch name; base ref defaults to HEAD.

## Steps

1. **Preconditions.** The repo has at least one commit and the target path does not exist. A
   worktree checks out committed state only — if the caller's task depends on uncommitted changes,
   stop and report "commit or stash first".
2. **Create.** `git worktree add <path> -b <branch> [<base-ref>]`.
3. **Replicate local config.** Copy from the main checkout the untracked files the project needs
   to run — `.env`, `.env.*`, and similar gitignored local config. When unsure what is needed,
   check the project's README and agent instructions for required local files.
4. **Install dependencies.** Use the package manager the lockfile implies (`bun.lock` → `bun
   install`, and so on), run inside the worktree.
5. **Verify green.** Run the project's cheapest defined health check — typecheck, build, or test
   script — inside the worktree. Ready means it passes the same check the main checkout passes.
6. **Report.** Reply with: path, branch, base commit, and which check passed. On any failure,
   report it verbatim and stop — never hand off a broken worktree as ready.
