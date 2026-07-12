# Codex Portable Blind-Delegation Smoke

Verifies the Caara-managed Codex guidance with the proven real Claude portable target. Install the
compiled user service and guidance first:

```bash
./dist/caara install-codex-roles --agents-md
./dist/caara doctor
```

Start a fresh Codex task so global `AGENTS.md` changes are loaded. Ask Codex:

```text
Delegate a read-only review of package.json to Claude through Caara's portable blind-delegation
workflow. Show me the human observation link immediately. Never open or inspect that link. Wait
until terminal completion, then give me only Claude's final answer.
```

Expected evidence:

- Codex selects an explicit `claude/...` target and safely supplies the prompt to `caara agent`.
- Codex surfaces `observationUrl` immediately; the human may open it in a trusted browser.
- Codex does not call browser, fetch, curl, or another tool with the capability URL.
- While exit status is 11, Codex repeats `agent wait` without reporting viewer activity.
- Codex consumes only terminal `finalAnswer`; no reasoning, tools, transcript, or viewer HTML enters
  the managing context.
- If cancelled, Codex uses `agent cancel` and honors `sessionReusable`.

Retain the Codex rollout and Caara service log under `temp.local/$(date +%F)/codex-portable-smoke/`.
Search the rollout for the capability token and verify it appears only in the surfaced link, never
in a tool request. Remove only Caara-owned guidance with `./dist/caara uninstall-codex-roles`.

The opt-in automated form runs real Codex against the already-installed guidance and service:

```bash
CAARA_REAL_CODEX_PORTABLE_SMOKE=1 bun run test src/codexPortableInstalledSmoke.test.ts --run
```

Set `CAARA_SMOKE_CODEX_EXECUTABLE` when `codex` is not on `PATH`.
