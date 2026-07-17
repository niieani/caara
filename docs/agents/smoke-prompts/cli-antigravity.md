# Execute The CLI → Antigravity Smoke

Read `docs/agents/smoke-testing.md` completely, then execute its global compiled-service setup and
shared three-turn lifecycle contract against `agy/gemini-3.5-flash` using `./dist/caara` directly.
This is an authenticated, metered smoke: stop unless the user explicitly authorized it in the
current conversation.

Requirements:

- Create `RUN_DIR` under `temp.local/$(date +%F)/cli-antigravity/<timestamp>/`.
- Use cwd `$PWD`, `--option effort=low`, JSON output, and no orchestrating-agent delegation.
- Turn 1: unique nonce; ask Antigravity to remember it, inspect `package.json` read-only, and reply
  exactly `AGY_INITIAL_OK <nonce>`.
- Fetch the capability viewer as the trusted smoke verifier. Require live Antigravity activity and
  a completed final state while proving CLI output contains no transcript/activity details.
- Turn 2: resume turn 1's `sessionId`; require exactly
  `AGY_CONTINUITY_OK <nonce> package.json`.
- Turn 3: resume the same session and request a detailed read-only review of every TypeScript source
  file. Wait for transcript/viewer activity, capture the unique `agy` harness PID, cancel, and prove
  that PID exited before cancellation returned.
- Once transcript mutation has occurred, require `outcome=Terminated` and
  `sessionReusable=false`. Record earlier `Interrupted` cancellation as insufficient setup rather
  than accepting a different policy branch.
- Verify start/wait/cancel never expose reasoning, transcript paths, `step_index`, tool activity, or
  viewer HTML. Retain the Antigravity conversation id and transcript path as private evidence.
- Write `result.md`; clean up only the provider process owned by this smoke.

Do not modify repository files. Do not install or reuse the global Caara service.

