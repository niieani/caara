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

- Provider integration tests with Diagnostic driver runtime failures.
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
- Preserve current Claude routing through driver registry tests and live registries.

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
- `sessionBindingV2Contract.test.ts` covers missing binding, wrong-driver binding, and invalid
  driver-owned cursor failures.
- Claude Code policy/session tests assert durable session cursor persistence through the updated binding model.

## Completed Slice: CAARA-nwpnzjlo

Problem:

- Runtime output was collapsed into two coarse events: reasoning delta and completed assistant message.
- The stream encoder completed successful Responses output when a runtime stream ended, even if no explicit runtime terminal success was observed.

Target:

- Replace the coarse runtime event union with item/content lifecycle events for assistant text and displayable reasoning summaries.
- Add explicit runtime terminal success and failure events.
- Make the Responses encoder item-id-aware and terminal-aware, so terminal failure cannot become `response.completed`.
- Update Diagnostic and Claude driver shims to emit lifecycle events plus terminal success.

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

- Default SDK turns to noninteractive permission mode and disallow `AskUserQuestion`.
- Reject user-supplied tool options that attempt to allow `AskUserQuestion`.
- Auto-deny SDK permission prompts, cancel unsupported SDK user dialogs, and relay `PermissionDenied` runtime context without producing Responses output.

Test seam:

- `claudeAgentSdkPermissionPolicy.test.ts` covers SDK permission callbacks, dialog cancellation, reserved-tool validation, and `permission_denied` runtime mapping.
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
- Provider/session tests prove Bun platform services are supplied at integration edges.

## Completed Slice: CAARA-exzcerfi

Problem:

- Retired Claude CLI adapter files still encoded the old production shape: argv construction, `Bun.spawn`, stdout JSONL parsing, handwritten stream message unions, and fake executable tests.
- User-facing docs still described Claude stdout parsing as current behavior.

Target:

- Remove `src/claudeCodeDriver` and `src/claudeCodeContract` source and tests.
- Keep production routing on `claudeAgentSdkDriverLive`.
- Add an architecture regression proving retired Claude CLI source and direct `Bun.spawn` do not return.
- Update current docs to describe SDK `query()` execution and imported SDK message boundaries.

Test seam:

- `claudeCliRetirement.test.ts` fails if retired `claudeCodeDriver`/`claudeCodeContract` files or direct `Bun.spawn` calls reappear under `src`.
- Existing SDK driver, cancellation, recovery, permission-policy, and provider routing tests cover the replacement SDK query seam.

## Completed Slice: CAARA-iqbzhbva

Problem:

- The SDK prompt bridge still returned plain text and selected only `input_text`.
- Prior non-message/tool history caused prompt decode failure instead of being ignored.
- Images, path references, opaque file ids, and unknown current-turn content were not handled intentionally.

Target:

- Build a one-shot `AsyncIterable<SDKUserMessage>` for the latest user message only.
- Map `input_text` to SDK text blocks and `input_image.image_url` to SDK image blocks for supported data URLs and HTTP(S) URLs.
- Map `input_file.file_path` / `input_file.path` to explicit workspace-file text only when the path stays within the driver cwd.
- Fail opaque `file_id`, unknown content types, malformed images, and out-of-workspace paths explicitly.

Test seam:

- `prompt.test.ts` covers text-only, data-url image, workspace path, opaque file-id rejection, unknown content rejection, and history-not-replayed behavior.
- `claudeAgentSdkDriver.test.ts` asserts SDK driver requests now carry SDK user-message prompt streams while retaining session/options behavior.

## Completed Slice: CAARA-cgjfrhwf

Problem:

- Claude SDK tool, task, and progress messages were not surfaced through Caara's runtime item lifecycle.
- Codex-visible activity needed to be concise assistant commentary, not Responses tool-call items or raw SDK payloads.
- Users needed a driver-owned option to hide SDK activity chatter without dropping relay observability.

Target:

- Map SDK tool-use, tool-result, task-started, and task-progress messages to runtime `ItemCreated` events.
- Emit terse commentary-phase assistant messages by default, such as `Reading src/server.ts`.
- Add `activity=off` to retain relay log records while suppressing Codex-visible activity commentary.

Test seam:

- `claudeAgentSdkActivity.test.ts` covers a fake SDK tool lifecycle plus task/progress messages through SSE output, relay logs, payload redaction, and `activity=off` behavior.
- Existing SDK driver tests assert final assistant text remains `phase: "final_answer"` after the runtime phase split.
