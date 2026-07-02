# Smoke Testing

Use this flow to verify the local Caara provider through Codex's real subagent path.

Checked-in real-agent roles:

- `agent_type = "caara-claude"`: Claude SDK driver with `model = "claude/haiku"`.
- `agent_type = "caara-claude-fable"`: Claude SDK driver with `model = "claude/fable"`.
- `agent_type = "caara-antigravity"`: Antigravity CLI driver with
  `model = "agy/gemini-3.5-flash"`.

For Caara-core smokes that do not need Claude, use the Diagnostic driver roles and runbooks in
`docs/agents/diagnostic-smoke-runbooks.md`. Keep the Claude SDK flow below for the real
Claude-backed subagent path.

For Antigravity-backed smokes, use `docs/agents/antigravity-smoke-runbook.md`. It mirrors the
Codex subagent first/resume/cancel flow below for the real `agy` driver path.

## Claude SDK Subagent Flow

1. Start the local provider:

```bash
bun run start
```

Expected startup line:

```text
Listening on http://localhost:8787
```

Optional health preflight from another terminal:

```bash
bun src/caara.ts status
```

Expected output:

```text
Caara healthy at http://127.0.0.1:8787/health
```

Installed-service status and health behavior is documented in
[docs/caara.md](../caara.md#user-service-and-operations).

When investigating lifecycle or duplication bugs, retain the provider log under `temp.local`:

```bash
RUN_DIR="$PWD/temp.local/$(date +%F)/claude-smoke/$(date +%H%M%S)"
mkdir -p "$RUN_DIR"
bun run start > "$RUN_DIR/provider.log" 2>&1
```

2. Spawn a Codex subagent with `agent_type = "caara-claude"`.

Do not pass a `model` override. The role sets `model = "claude/haiku"` and points at
`http://127.0.0.1:8787/v1`. No provider query parameters are required for the standard subagent
smoke.

Use `agent_type = "caara-claude-fable"` only when intentionally testing Fable. That role sets
`model = "claude/fable"`; Anthropic documents Fable as requiring Claude Code `v2.1.170+` and not
being available under zero data retention.

First-turn prompt:

```text
Please verify your working directory and read one specific source line.

1. Report your current working directory.
2. Read line 5 of README.md in that working directory.
3. Reply with exactly two fields: cwd=<your cwd> and readme_line_5=<the exact line 5 text>.
4. Do not edit files.
```

3. Wait for completion.

Expected first-turn response includes:

```text
cwd=/Volumes/Projects/Software/code-agents-as-responses-api
readme_line_5=Current implementation routes `claude/<model>` targets to Claude Code and `agy/<model>` targets to Antigravity, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.
```

Effort serialization check: change Codex's effort selector, run another first turn through the same
role, and inspect the retained provider log:

```bash
rg '"event":"caara.responses.request"|"reasoning"|"effort"' "$RUN_DIR/provider.log"
```

Expected: the logged request body includes `reasoning.effort` with the selected dynamic effort.
This proves Codex serialized the advisory signal into Caara. Claude SDK effort behavior is then
driver-owned: `query_params.effort` still overrides the advisory signal and remains the way to
request Claude-only `max`.

4. Send a follow-up prompt on the same subagent handle:

```text
What did I just ask you to verify? Answer from this subagent conversation context. Mention the working directory check and the README.md line number.
```

Expected follow-up response: the Claude-backed subagent identifies the previous cwd check and
`README.md` line 5 request from the same external Claude Code session.

Relay evidence to check:

- `TargetSelected` requested `claude/haiku`.
- Fable role variant: `TargetSelected` requested `claude/fable`.
- `DriverStarted` used external agent kind `claude`.
- The follow-up `DriverStarted` includes an external Claude session id and `previousTarget`.
- `RuntimeEventRelayed` includes normal runtime item lifecycle records.
- Tool activity appears as assistant `phase = "commentary"` messages such as `Using Bash`,
  `Bash completed`, `Reading ...`, and `Read completed`. Single-line Bash commands appear as
  `Using Bash:` followed by an inline-code command, for example ``Using Bash: `pwd` ``. Multiline
  Bash commands appear under `Using Bash:` in a shell code block:

````markdown
Using Bash:
```bash
printf 'first line\n'
pwd
```
````

- Final assistant text appears as `phase = "final_answer"`.

5. Start a long-running turn on the same handle, then close the spawned agent while it is running.

Expected observation: Caara logs `TurnCancelled` with the `claude` session key and the driver
reports whether the session remains reusable. A clean SDK cancellation should normally log
`outcomeTag = "Interrupted"` and `sessionReusable = true`.

6. Stop the local provider.

## Matching Codex Rollouts To Claude Logs

Use this when a smoke shows duplicate thinking/tool text, a wrong `phase`, or a final answer that
appears twice.

Codex rollout logs show what Codex/Halley received after Caara translated the driver runtime events.
They live under `~/.codex/sessions/<year>/<month>/<day>/`. If you know the subagent id returned by
the spawn tool, find the matching rollout with:

```bash
SUBAGENT_ID="019ef6e3-3cc6-7cf0-afe0-8f8d94647a72"
find "$HOME/.codex/sessions" -name "rollout-*-${SUBAGENT_ID}.jsonl" -print | sort | tail -1
```

Claude Code session logs show what the underlying Claude agent actually emitted before Caara mapped
it to Responses lifecycle events. For this repo they live under:

```text
~/.claude/projects/-Users-bbrzoska-Documents-Projects-caara/
```

The most reliable join key is the Claude session id from Caara's `DriverStarted` relay log. In a
retained provider log, find it with:

```bash
rg '"_tag":"DriverStarted"|externalSessionId|threadId|turnId' "$RUN_DIR/provider.log"
```

The `externalSessionId` field contains a JSON payload with `sessionId`. The Claude log filename is
that session id plus `.jsonl`:

```bash
CLAUDE_SESSION_ID="388cd466-9767-4652-9604-d1ea7b86cc4e"
CLAUDE_LOG="$HOME/.claude/projects/-Users-bbrzoska-Documents-Projects-caara/${CLAUDE_SESSION_ID}.jsonl"
```

If the provider log was not retained, inspect the most recent Claude logs around the Codex rollout
timestamp and match by prompt text, tool command, and turn order:

```bash
ls -t "$HOME/.claude/projects/-Users-bbrzoska-Documents-Projects-caara"/*.jsonl | head -5
```

Comparison rules:

- If Claude's JSONL contains duplicate `tool_use` or `tool_result` records, duplicate `Using ...` or
  `... completed` commentary in Codex is probably real upstream agent activity.
- If Claude emits one tool call but the Codex rollout contains duplicate assistant lifecycle items,
  the bug is likely in Caara's SDK-to-runtime mapping or Responses encoding.
- If Claude emits pre-tool assistant text followed by `tool_use`, Codex should receive that text as
  `phase = "commentary"`. Seeing `phase = "final_answer"` points at assistant phase mapping.
- If the Codex rollout has one final assistant message plus the same text in
  `task_complete.last_agent_message`, treat `last_agent_message` as completion metadata. Rendering
  both as visible messages is a UI/client duplication bug, not a second driver response.

## Supplemental Direct Provider Checks

Use Codex-shaped direct HTTP requests only for provider query options that the checked-in
`caara-claude` role cannot pass, such as `activity=off` or invalid tool options. Keep helper scripts
and JSON artifacts under `temp.local/$(date +%F)/`.

Recommended supplemental checks:

- `GET` query equivalent `?tools=default`: ask Claude to use Bash and verify commentary messages are
  visible.
- `?tools=default&activity=off`: ask the same thing and verify no assistant commentary messages are
  visible while relay logs still include runtime item lifecycle events.
- `?allowed_tools=AskUserQuestion`: verify the turn fails explicitly with the reserved interactive
  tool validation error.
- Same synthetic thread id with a changed cwd: verify `LostSessionRecovered`, the Caara-owned
  recovery assistant text, and a new persisted driver resume cursor.

## SDK Architecture Checks

To distinguish the SDK-backed path from the retired Claude CLI path:

- `src/caara.ts` should compose `claudeAgentSdkDriverLive`.
- `src/claudeAgentSdkDriver/claudeCliRetirement.test.ts` should pass. It rejects retired
  `claudeCodeDriver`, retired `claudeCodeContract`, and direct `Bun.spawn` source under `src`.
- Smoke logs should show `TargetSelected` and `DriverStarted` for external agent kind `claude`, not
  CLI argv or stdout JSONL records.

## Troubleshooting

If `agent_type = "caara-claude"` or `agent_type = "caara-claude-fable"` is unavailable, check the
matching `.codex/agents/*.toml` file exists and includes its embedded `[model_providers.caara]`
block.

If the subagent spawn succeeds but the turn fails, check the provider process is still listening on `127.0.0.1:8787`.

If Codex rejects the role config, keep the provider block inside each `.codex/agents/caara-*.toml` file; project-level `.codex/config.toml` is not enough for role-layer validation.
