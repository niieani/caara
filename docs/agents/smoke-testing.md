# Smoke Testing

Use this flow to verify the local Caara mock provider through Codex's real subagent path.

## Caara Subagent Flow

1. Start the local provider:

```bash
bun run start
```

Expected startup line:

```text
Listening on http://localhost:8787
```

2. Spawn a Codex subagent with `agent_type = "caara"`.

Do not pass a `model` override; the role sets `model = "fake-model"`.

Example prompt:

```text
Smoke test prompt: return whatever the provider returns.
```

3. Wait for completion.

Expected subagent final response:

```text
Yes, the mock subagent seems to be working
```

4. Check the provider terminal output.

Expected observation: the provider logs the full Responses `input` JSON sent by Codex.

5. Close the spawned agent handle and stop the local provider.

## Troubleshooting

If `agent_type = "caara"` is unavailable, check `.codex/agents/caara.toml` exists and includes its embedded `[model_providers.caara]` block.

If the subagent spawn succeeds but the turn fails, check the provider process is still listening on `127.0.0.1:8787`.

If Codex rejects the role config, keep the provider block inside `.codex/agents/caara.toml`; project-level `.codex/config.toml` is not enough for role-layer validation.
