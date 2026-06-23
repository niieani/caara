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

## Completed Slice: CAARA-nwpnzjlo

Problem:

- Runtime output was collapsed into two coarse events: reasoning delta and completed assistant message.
- The stream encoder completed successful Responses output when a runtime stream ended, even if no explicit runtime terminal success was observed.

Target:

- Replace the coarse runtime event union with item/content lifecycle events for assistant text and displayable reasoning summaries.
- Add explicit runtime terminal success and failure events.
- Make the Responses encoder item-id-aware and terminal-aware, so terminal failure cannot become `response.completed`.
- Update simulator and Claude Code driver shims to emit lifecycle events plus terminal success.

Test seam:

- `runtimeLifecycle.test.ts` covers complete assistant text, complete reasoning, and partial output followed by terminal failure.
- Provider and registry-routing tests assert relay logs now expose the runtime lifecycle tag sequence.
- Runtime failure tests continue proving failed streams emit `response.failed` and do not save completed bindings.

## Completed Slice: CAARA-hmdoazmi

Problem:

- SDK cancellation returned reusable after `interrupt()` alone.
- No bounded drain verified whether the SDK reported a terminal aborted result.

Target:

- On cancellation, call `Query.interrupt()`, drain SDK messages until `result`, stream end, failure, or timeout.
- Keep session reusable only for `aborted_streaming` or `aborted_tools` terminal reasons.
- Close the SDK query and report non-reusable for interrupt failure, stream failure, timeout, or no terminal result.

Test seam:

- `claudeAgentSdkCancellation.test.ts` covers abort before first event, after partial output, follow-up abort, clean reusable `aborted_tools`, no-result ambiguity, interrupt failure, and stream failure.

## Completed Slice: CAARA-fcigyzat

Problem:

- Claude SDK permission prompts and user dialogs could reach Caara without a deterministic noninteractive policy.
- `AskUserQuestion` could be requested through user-supplied tool options.
- SDK `permission_denied` system messages were not represented in Caara runtime or relay logs.

Target:

- Default SDK and Claude Code turns to noninteractive permission mode and disallow `AskUserQuestion`.
- Reject user-supplied tool options that attempt to allow `AskUserQuestion`.
- Auto-deny SDK permission prompts, cancel unsupported SDK user dialogs, and relay `PermissionDenied` runtime context without producing Responses output.

Test seam:

- `claudeAgentSdkPermissionPolicy.test.ts` covers SDK permission callbacks, dialog cancellation, reserved-tool validation, and `permission_denied` runtime mapping.
- `claudeCodePermissionPolicy.test.ts` and `claudeCodeContract.test.ts` cover CLI defaults and reserved-tool validation.
- `agentRegistryRouting.test.ts` covers relay logging and response completion for `PermissionDenied` runtime events.

## Completed Slice: CAARA-sbvkyfbv

Problem:

- Session binding persistence used direct `node:fs/promises`, `node:path`, `node:os`, `Bun.file`, and import-time `process.env` state-dir resolution.
- Codex workspace/cwd validation used `node:path` directly instead of an injectable path service.
- Provider integration tests could not substitute session-directory host IO without touching the real filesystem.

Target:

- Move session-directory reads, writes, deletes, and path construction behind injected `FileSystem.FileSystem` and `Path.Path`.
- Resolve live Caara state directory at layer construction through an explicit env config seam that fails without `CAARA_STATE_DIR`, `XDG_STATE_HOME`, or `HOME`.
- Move Codex absolute-path filtering to injected `Path.Path`.
- Provide Bun platform services at app/test composition edges while keeping tests able to inject fake platform services.

Test seam:

- `sessionDirectoryPlatformServices.test.ts` proves fake `FileSystem` injection is used and empty env fails explicitly.
- `codexTurnContext.test.ts` proves workspace path filtering uses injected `Path`.
- Provider/session/Claude Code harness tests prove Bun platform services are supplied at integration edges.
