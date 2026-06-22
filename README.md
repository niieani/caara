# caara

OpenAI-compatible Responses API wrapper for code-agent subagent experiments.

Current implementation is a mock provider for Codex: it logs request `input`,
streams fake reasoning, then returns a fixed assistant answer.

To install dependencies:

```bash
bun install
```

To run the mock Responses provider on `127.0.0.1:8787`:

```bash
bun run start
```

Local Codex subagent config lives in `.codex/agents/caara.toml`:

```toml
name = "caara"
description = "Delegates to the local Caara mock Responses provider."
developer_instructions = "Use the local Caara mock Responses provider. Do not call tools. Return the provider response as-is."
model_provider = "caara"
model = "fake-model"

[model_providers.caara]
name = "Caara Mock Responses"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

The provider block is embedded in the role file because Codex validates agent
role config layers before merging project-level provider config.

Supported endpoint:

- `POST /v1/responses`
- requires `stream: true`
- logs request `input`
- emits `response.reasoning_summary_text.delta` with `thinking how best to respond`
- emits `response.output_item.done` with `Yes, the mock subagent seems to be working`
- finishes with `response.completed`

Validation:

```bash
bun run test mockResponsesProvider.test.ts
bun run typecheck
bun lint
```
