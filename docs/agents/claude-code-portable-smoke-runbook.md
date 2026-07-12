# Claude Portable Blind-Delegation Smoke

Verifies the auto-discoverable personal Claude skill against real Antigravity through the installed
Caara service.

```bash
./dist/caara install-claude-guidance
./dist/caara doctor
```

Start a fresh Claude Code session, then ask it to use `caara-delegate` for a read-only Antigravity
delegation. It must show the human observation link immediately, never inspect that link, wait until
terminal completion, and return only the delegated final answer. This workflow uses the portable
Caara CLI, not Claude's native subagent facility.

Expected evidence:

- Claude selects the explicit real `agy/gemini-3.5-flash` target and supplies multiline input via a
  prompt file.
- The observation capability appears in assistant text before terminal output, never in Bash or
  another tool input.
- Claude repeats `agent wait` for exit 11 and consumes only terminal `finalAnswer`.
- No viewer HTML, reasoning, tools, or transcript enters Claude's context.
- Uninstall removes only the marked Caara skill; unrelated `~/.claude` files remain.

Retain Claude stream-json and service logs under
`temp.local/$(date +%F)/claude-portable-smoke/`. Run the gated structural smoke with:

```bash
CAARA_REAL_CLAUDE_PORTABLE_SMOKE=1 bun run test src/claudePortableInstalledSmoke.test.ts --run
```

Set `CAARA_SMOKE_CLAUDE_EXECUTABLE` when `claude` is not on `PATH`. Cleanup:

```bash
./dist/caara uninstall-claude-guidance
```
