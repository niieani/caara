# Mock Responses Provider

## Brief

Build a basic local OpenAI-compatible Responses API provider for Codex subagent experiments.

## Goal

`POST /v1/responses` accepts Codex-style streaming Responses requests, logs `input`, emits fake reasoning text `thinking how best to respond`, emits final assistant text `Yes, the mock subagent seems to be working`, then completes with `response.completed`.

## Scope

In scope:

- Bun + TypeScript + Effect v4 implementation.
- `@effect/platform-bun` HTTP server boundary.
- Effect schema validation at JSON boundary.
- Effect SSE decoding and `@effect/ai-openai` Responses stream schema validation in tests.
- DI logging seam for captured tests and live stdout.
- Focused integration test through a real Bun-platform test server.

Out of scope:

- Tool calls.
- Non-streaming Responses API.
- Real model/subagent execution.
- Auth.
- Backward-compatible legacy paths.

## Criteria

- Streaming request returns `text/event-stream`: integration test.
- Request `input` logged exactly once: integration test via injected logger.
- Reasoning SSE includes `thinking how best to respond`: integration test.
- Message SSE includes `Yes, the mock subagent seems to be working`: integration test.
- Stream includes terminal `response.completed`: integration test.
- Emitted stream events decode through Effect OpenAI Responses stream schema: integration test.
- Unsupported or malformed request fails explicitly: test or review.
- Typecheck/lint pass: `bun run typecheck`, `bun lint`.

## Execution

Small direct feature. Red test first, then implementation, then focused validation.
