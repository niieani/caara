# Smoke Testing

Use this flow to verify the local Caara provider through Codex's real subagent path.

For Caara-core smokes that do not need Claude, use the Diagnostic driver roles and runbooks in
`docs/agents/diagnostic-smoke-runbooks.md`. Keep the Claude SDK flow below for the real
Claude-backed subagent path.

## Claude SDK Subagent Flow

1. Start the local provider:

```bash
bun run start
```

Expected startup line:

```text
Listening on http://localhost:8787
```

2. Spawn a Codex subagent with `agent_type = "caara"`.

Do not pass a `model` override. The role sets `model = "claude/haiku"` and points at
`http://127.0.0.1:8787/v1`. No provider query parameters are required for the standard subagent
smoke.

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
readme_line_5=Current implementation routes `claude/<model>` targets to Claude Code, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.
```

4. Send a follow-up prompt on the same subagent handle:

```text
What did I just ask you to verify? Answer from this subagent conversation context. Mention the working directory check and the README.md line number.
```

Expected follow-up response: the Claude-backed subagent identifies the previous cwd check and
`README.md` line 5 request from the same external Claude Code session.

Relay evidence to check:

- `TargetSelected` requested `claude/haiku`.
- `DriverStarted` used external agent kind `claude`.
- The follow-up `DriverStarted` includes an external Claude session id and `previousTarget`.
- `RuntimeEventRelayed` includes normal runtime item lifecycle records.
- Tool activity appears as assistant `phase = "commentary"` messages such as `Using Bash`,
  `Bash completed`, `Reading ...`, and `Read completed`.
- Final assistant text appears as `phase = "final_answer"`.

5. Start a long-running turn on the same handle, then close the spawned agent while it is running.

Expected observation: Caara logs `TurnCancelled` with the `claude` session key and the driver
reports whether the session remains reusable. A clean SDK cancellation should normally log
`outcomeTag = "Interrupted"` and `sessionReusable = true`.

6. Stop the local provider.

## Supplemental Direct Provider Checks

Use Codex-shaped direct HTTP requests only for provider query options that the checked-in `caara`
agent role cannot pass, such as `activity=off` or invalid tool options. Keep helper scripts and JSON
artifacts under `temp.local/$(date +%F)/`.

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

If `agent_type = "caara"` is unavailable, check `.codex/agents/caara.toml` exists and includes its embedded `[model_providers.caara]` block.

If the subagent spawn succeeds but the turn fails, check the provider process is still listening on `127.0.0.1:8787`.

If Codex rejects the role config, keep the provider block inside `.codex/agents/caara.toml`; project-level `.codex/config.toml` is not enough for role-layer validation.
