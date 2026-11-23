# Execute The CLI → Codex Smoke

Read `docs/agents/smoke-testing.md` completely, then execute its global compiled-service setup and
shared three-turn lifecycle contract against `codex/gpt-5.6` using `./dist/caara` directly. This is
an authenticated, metered smoke: stop unless the user explicitly authorized it in the current
conversation.

Requirements:

- Create `RUN_DIR` under `temp.local/$(date +%F)/cli-codex/<timestamp>/`.
- Use cwd `$PWD`, JSON output, and no orchestrating-agent delegation.
- Turn 1: unique nonce; ask Codex to remember it, inspect `package.json` read-only, and reply exactly
  `CODEX_INITIAL_OK <nonce>`.
- Fetch the capability viewer as the trusted smoke verifier. Require live Codex reasoning/activity
  and a completed final state while proving CLI output contains no private activity.
- Turn 2: resume turn 1's `sessionId`; require exactly
  `CODEX_CONTINUITY_OK <nonce> package.json` and retain the resumed Codex thread id.
- Turn 3: resume the same session and request a detailed read-only review of every TypeScript source
  file. Wait for live viewer activity, capture the unique child `codex exec` PID, cancel, and prove
  that PID exited before cancellation returned.
- Require `outcome=Terminated` and `sessionReusable=false` unless the implemented Codex cancellation
  contract has deliberately changed and the playbook was updated with matching automated fake
  boundary coverage.
- Verify start/wait/cancel never expose reasoning, JSONL activity, commands, or viewer HTML.
- Run `./dist/caara` from a shell with no Codex marker (`CODEX_THREAD_ID`, or `CAARA_HARNESS=codex`).
  Caara treats a Codex shell as the immediate caller and rejects Codex → Codex before `codex exec`
  starts. Record one deliberate rejection check: rerun turn 1's start with
  `CODEX_THREAD_ID=smoke-native-marker` and require exit 70 with a message naming Codex's native
  subagents (`spawn_agent`) and no new `codex exec` process.
- Write `result.md`; clean up only the provider process owned by this smoke.

Do not modify repository files. Do not install or reuse the global Caara service.

