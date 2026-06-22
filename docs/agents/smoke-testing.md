# Smoke Testing

Use this flow to verify the local Caara provider through Codex's real subagent path.

## Claude Code Subagent Flow

1. Start the local provider:

```bash
bun run start
```

Expected startup line:

```text
Listening on http://localhost:8787
```

2. Spawn a Codex subagent with `agent_type = "caara"`.

Do not pass a `model` override; the role sets `model = "claude/haiku"` and points at
`http://127.0.0.1:8787/v1`. No provider query parameters are required for the standard smoke.

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
readme_line_5=Current implementation is a mock provider for Codex: it logs request `input`,
```

4. Send a follow-up prompt on the same subagent handle:

```text
What did I just ask you to verify? Answer from this subagent conversation context. Mention the working directory check and the README.md line number.
```

Expected follow-up response: the Claude-backed subagent identifies the previous cwd check and
`README.md` line 5 request from the same external Claude Code session.

5. Start a long-running turn on the same handle, then close the spawned agent while it is running.

Expected observation: Caara logs `TurnCancelled` with the `claude` session key and the driver
reports whether the session remains reusable.

6. Stop the local provider.

## Troubleshooting

If `agent_type = "caara"` is unavailable, check `.codex/agents/caara.toml` exists and includes its embedded `[model_providers.caara]` block.

If the subagent spawn succeeds but the turn fails, check the provider process is still listening on `127.0.0.1:8787`.

If Codex rejects the role config, keep the provider block inside `.codex/agents/caara.toml`; project-level `.codex/config.toml` is not enough for role-layer validation.
