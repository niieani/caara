# Antigravity Orchestrator Portable Blind-Delegation Smoke

Verifies Antigravity as the managing agent and real `claude/sonnet` as the delegated target through
the installed Caara user service. This is distinct from the Antigravity driver smoke, where
Antigravity is the delegated target.

```bash
./dist/caara install-antigravity-guidance
./dist/caara doctor
```

Start a fresh Antigravity print-mode turn. Ask it to follow its global `~/.gemini/GEMINI.md` Caara
rules, delegate a read-only task to `claude/sonnet`, and return an exact marker. Antigravity must use
`caara agent start|wait|cancel`; it must not use native subagent internals.

Expected evidence:

- The model surfaces the human observation URL before its exact terminal answer.
- The URL never appears in tool input and no tool input attempts to open, fetch, or reconstruct the
  viewer.
- The workflow consumes only the portable terminal `finalAnswer`; viewer HTML, reasoning, tool
  activity, and transcript content remain outside the orchestrator context.
- Uninstall preserves unrelated global Antigravity rules and removes `GEMINI.md` only when its
  contents are exclusively Caara-owned.

The gated smoke runs real `agy` using its documented print protocol (`--prompt`, `--model`,
`--log-file`, `--print-timeout`). It retains stdout, stderr, and the diagnostic log under
`temp.local/2026-07-12/antigravity-orchestrator-smoke-*/`, extracts `Created conversation <uuid>`,
then structurally checks that conversation's `transcript_full.jsonl` to distinguish model speech
from tool inputs.

```bash
CAARA_REAL_ANTIGRAVITY_ORCHESTRATOR_SMOKE=1 \
  bun run test src/antigravityOrchestratorInstalledSmoke.test.ts --run
```

Set `CAARA_SMOKE_ANTIGRAVITY_EXECUTABLE` when `agy` is not on `PATH`. Cleanup only Caara-owned
guidance:

```bash
./dist/caara uninstall-antigravity-guidance
```
