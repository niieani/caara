# Caara

Caara is an OpenAI-compatible Responses API wrapper for running other code agents as Codex subagents.

The current implementation is a local mock provider. It exists to prove the Codex provider and subagent wiring before connecting a real agent backend such as Claude Code or Antigravity.

## Current Behavior

Caara serves `POST /v1/responses` on `http://127.0.0.1:8787`.

Supported request shape:

- `model`: required string
- `input`: required JSON value
- `stream`: must be `true`

For every valid request, Caara:

- logs the request `input`
- streams OpenAI Responses SSE events
- emits fake reasoning text: `thinking how best to respond`
- emits final assistant text: `Yes, the mock subagent seems to be working`
- ends with `response.completed`

Malformed requests and non-streaming requests fail explicitly with an OpenAI-shaped `invalid_request_error`.

## Codex Role Configuration

The local Codex role lives at `.codex/agents/caara.toml`. It is self-contained: the role file includes both the `caara` agent config and the `[model_providers.caara]` provider block.

The provider block is intentionally embedded in the role file because Codex validates role config layers before merging project-level provider config.

## Effect Usage

The HTTP server is built on Effect v4 and `@effect/platform-bun`.

SSE framing uses Effect's native `effect/unstable/encoding/Sse` encoder. Tests decode streamed bytes with the same Effect SSE decoder and validate payloads against `@effect/ai-openai/OpenAiSchema.ResponseStreamEvent`.

## Validation

Primary checks:

```bash
bun run test mockResponsesProvider.test.ts
bun run typecheck
bun lint
```

Manual Codex subagent smoke testing is documented in `docs/agents/smoke-testing.md`.
