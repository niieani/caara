# caara

Caara lets Codex spawn external code agents as subagents through the OpenAI Responses API.

Current implementation routes `claude/<model>` targets to Claude Code, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.

## Install

```bash
bun install
```

## Run

Start the local Responses-compatible bridge on `127.0.0.1:8787`:

```bash
bun run start
```

Supported endpoint:

- `POST /v1/responses`
- requires `stream: true`
- requires a model string in `<external-agent-kind>/<external-model>` form
- currently supports the `claude/*` external agent kind
- streams OpenAI Responses SSE events back to Codex

## Codex Agent

Local Codex subagent config lives in `.codex/agents/caara.toml`:

```toml
name = "caara"
description = "Delegates to the local Caara Responses provider backed by Claude Code."
developer_instructions = "Use the local Caara Responses provider. Relay the provider response as-is."
model_provider = "caara"
model = "claude/haiku"

[model_providers.caara]
name = "Caara Responses"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

The provider block is embedded in the role file because Codex validates agent role config layers before merging project-level provider config.

Manual Codex smoke flow: `docs/agents/smoke-testing.md`.

## State

Caara stores durable session bindings outside the project repository.

State directory resolution:

1. `CAARA_STATE_DIR`
2. `$XDG_STATE_HOME/caara`
3. `$HOME/.local/state/caara`

Session bindings are keyed by external agent kind and Codex thread id. They store resume metadata only; Claude Code remains the source of truth for conversation context.

## Validation

```bash
bun run fmt
bun lint
bun run typecheck
bun run test --run
```
