# Work Notes

## Source Of Truth

- fp PRD queue: CAARA-zoksjrdd -> CAARA-wkwdmzxd -> CAARA-nsldrqnt.
- Current PRD status: CAARA-zoksjrdd in progress.
- Known dependency issue: CAARA-cgjfrhwf depends on CAARA-uagzirfk from later PRD CAARA-wkwdmzxd.

## Completed Slice: CAARA-xedpqytc

Problem:

- `server.ts` catches runtime stream errors, logs `TurnFailed`, drains the failure, and lets the Responses encoder append `response.completed`.
- Finalizer sees stream success and persists a completed session binding.

Target:

- Runtime stream errors after turn start become `response.failed`, never `response.completed`.
- Finalizer releases in-flight ownership without completing the binding.
- Existing binding remains unchanged after failed follow-up.

Test seam:

- Provider integration tests with simulator driver runtime failures.
- Assert SSE events, relay logs, session binding file, and next-turn lease reuse.

## Completed Slice: CAARA-yrrtiwje

Problem:

- Driver, session directory, and turn concurrency services exported fake Effect "shape" values to infer method types.
- Driver cancellation used a zero-argument function returning an Effect, creating unnecessary lazy indirection.

Target:

- Replace fake shape values with named service/driver contract types.
- Keep runtime event stream, terminal outcome, cancellation, start, resolve, session directory, and concurrency contracts explicit.
- Exercise driver registry through `Context.Service` injection in focused tests.

Test seam:

- `agentDriverContract.test.ts` resolves a driver via `AgentDriverRegistry`, starts it, consumes the runtime stream, runs cancellation, and checks typed runtime failure stream behavior.

## Completed Slice: CAARA-tywjydqs

Problem:

- Codebase had no official Claude Agent SDK dependency.
- Claude SDK query creation had no injectable seam for tests.

Target:

- Add current `@anthropic-ai/claude-agent-sdk` and required peer dependencies with Bun.
- Introduce an Effect service that owns direct SDK `query()` calls.
- Expose SDK prompt/options/message types at the seam while keeping runtime fakes structural.

Test seam:

- `claudeAgentSdkClient.test.ts` injects a fake client, records typed SDK options, emits a typed SDK message via `AsyncIterable`, and never spawns Claude.

## Completed Slice: CAARA-aamjtkfx

Problem:

- Request decoding hard-coded `claude` as the only supported external agent kind.
- Driver registries did not explicitly reject unsupported kinds.

Target:

- Decode syntactically valid external agent kinds as open lowercase slugs.
- Make `AgentDriverRegistry.resolve` the owner of support checks.
- Preserve current Claude routing through simulator/live registries.

Test seam:

- `codexTurnContext.test.ts` accepts `gemini/pro` at decode time and rejects malformed kind syntax.
- `mockResponsesProvider.test.ts` proves a custom registry can serve `gemini/pro`, and the default registry rejects unsupported kinds after target selection.

## Completed Slice: CAARA-eodhueyo

Problem:

- Session binding persisted one loose external session id and request target fields directly on the binding.
- Follow-up lookup did not distinguish API response ids, driver identity, mutable requested target state, and driver-owned resume cursors.

Target:

- Persist session binding v2 with branded ids, a stable binding key, mutable requested target state, and opaque driver resume cursors.
- Route binding files through external agent kind, driver instance id, and Codex thread id.
- Let drivers own cursor encoding/decoding; core stores only the opaque cursor string.
- Fail explicitly for missing follow-up bindings, wrong-driver bindings, and driver-rejected cursors.

Test seam:

- `sessionBinding.test.ts` proves first-turn creation, follow-up lookup, mutable model/options, and cursor persistence.
- `sessionBindingV2Contract.test.ts` covers missing binding, wrong-driver binding, and invalid simulator cursor failures.
- Claude Code policy/session tests assert durable session cursor persistence through the updated binding model.
