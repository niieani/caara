# caara

Caara lets Codex spawn external code agents as subagents through the OpenAI Responses API.

Current implementation routes `claude/<model>` targets to Claude Code and `agy/<model>` targets to Antigravity, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.

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
- currently supports `claude/*`, `agy/*`, and `diagnostic/*` smoke-test targets
- streams OpenAI Responses SSE events back to Codex

## Codex Agent

Local Codex subagent configs live in `.codex/agents/caara-claude.toml` and
`.codex/agents/caara-antigravity.toml`:

| File                                   | `agent_type`        | Model                  |
| -------------------------------------- | ------------------- | ---------------------- |
| `.codex/agents/caara-claude.toml`      | `caara-claude`      | `claude/haiku`         |
| `.codex/agents/caara-antigravity.toml` | `caara-antigravity` | `agy/gemini-3.5-flash` |

Each role embeds the provider block:

```toml
[model_providers.caara]
name = "Caara Responses"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

The provider block is embedded in the role file because Codex validates agent role config layers before merging project-level provider config.

Caara role files set `model_supports_reasoning_summaries = true` so Codex can serialize the current
dynamic effort selector as request body `reasoning.effort`. Do not add `model_reasoning_effort`
unless a role intentionally pins fixed effort and disables dynamic selector behavior.

Driver query params remain highest precedence. For Claude, `query_params.effort` overrides Codex
advisory effort and is still required for Claude-only values such as `max`.

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
