# Execute The CLI → Claude Smoke

Read `docs/agents/smoke-testing.md` completely, then execute its global compiled-service setup and
shared three-turn lifecycle contract against `claude/sonnet` using `./dist/caara` directly. This is
an authenticated, metered smoke: stop unless the user explicitly authorized it in the current
conversation.

Requirements:

- Create `RUN_DIR` under `temp.local/$(date +%F)/cli-claude/<timestamp>/`.
- Use cwd `$PWD`, `--option effort=low`, JSON output, and no orchestrating-agent delegation.
- Turn 1: unique nonce; ask Claude to remember it, inspect `package.json` read-only, and reply
  exactly `CLAUDE_INITIAL_OK <nonce>`.
- Fetch the capability viewer as the trusted smoke verifier. Require live Claude activity and a
  completed final state while proving the CLI output contains neither activity nor viewer HTML.
- Turn 2: resume turn 1's `sessionId`; require exactly
  `CLAUDE_CONTINUITY_OK <nonce> package.json`.
- Turn 3: resume the same session and request a detailed read-only review of every TypeScript source
  file. Wait for live viewer/tool activity, capture and identify the Claude harness PID, cancel the
  turn, and prove that PID exited before cancellation returned.
- Require `outcome=Interrupted` and `sessionReusable=true`. Treat any other result as a failure and
  retain the SDK/provider evidence.
- Verify start/wait/cancel never expose Claude reasoning, tool calls, transcript fields, or viewer
  HTML. Record every exit code and decoded JSON result.
- Write `result.md`; clean up only the provider process owned by this smoke.

Do not modify repository files. Do not install or reuse the global Caara service.

