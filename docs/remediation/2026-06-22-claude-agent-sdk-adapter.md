# Claude Agent SDK Adapter Remediation

Date: 2026-06-22

Scope: investigation only. No implementation changes in this pass.

## Finding

The current Claude implementation is not the agreed SDK-based design. It is a hand-written
Claude Code print-mode CLI adapter:

- `src/claudeCodeContract/invocation.ts` builds `claude -p --verbose --output-format stream-json`.
- `src/claudeCodeDriver/process.ts` calls `Bun.spawn` directly and parses stdout/stderr itself.
- `src/claudeCodeContract/streamEvents.ts` defines a custom partial clone of Claude stream-json.
- `src/claudeCodeDriver/driver.ts` maps that custom clone into only two Caara events.
- `src/claudeCodeDriver/*.test.ts` fake a `claude` executable and assert argv/JSONL behavior.

That was useful as a smoke spike, but it is the wrong production seam. Caara should wrap
`@anthropic-ai/claude-agent-sdk` and import its types instead of cloning the CLI protocol.

## Evidence Read

Current Caara:

- `src/claudeCodeDriver/driver.ts`
- `src/claudeCodeDriver/process.ts`
- `src/claudeCodeDriver/options.ts`
- `src/claudeCodeDriver/prompt.ts`
- `src/claudeCodeContract/*`
- `src/mockResponsesProvider/agentDriver.ts`
- `src/mockResponsesProvider/server.ts`
- `src/mockResponsesProvider/sessionDirectory.ts`
- `src/mockResponsesProvider/responseEvents.ts`
- `src/mockResponsesProvider/codexTurnContext.ts`
- `src/claudeCodeDriver/*.test.ts`

Project docs/ADRs:

- `CONTEXT.md`
- `docs/caara.md`
- `docs/agents/testing-patterns.md`
- `docs/agents/claude-code-contract.md`
- `docs/adr/2026-06-21-codex-turn-context-separates-responses-transport-from-drivers.md`
- `docs/adr/2026-06-22-client-disconnect-cancels-turn.md`
- `docs/adr/2026-06-22-driver-options-are-driver-owned.md`
- `docs/adr/2026-06-22-driver-residency-is-opt-in.md`
- `docs/adr/2026-06-22-session-directory-stores-resume-metadata-only.md`
- `docs/adr/2026-06-22-session-identity-uses-external-agent-kind.md`
- `docs/adr/2026-06-22-unresumable-sessions-recover-through-dialogue.md`

Reference implementation:

- `references/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `references/t3code/apps/server/src/provider/Services/ProviderAdapter.ts`
- `references/t3code/apps/server/src/provider/Services/ProviderService.ts`
- `references/t3code/apps/server/src/provider/Services/ProviderSessionDirectory.ts`
- `references/t3code/apps/server/src/provider/Layers/ClaudeAdapter.test.ts`
- `references/t3code/apps/server/src/provider/Drivers/ClaudeDriver.ts`

SDK:

- Official TypeScript docs: `https://code.claude.com/docs/en/agent-sdk/typescript`
- Official overview: `https://code.claude.com/docs/en/agent-sdk/overview`
- Changelog: `https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md`
- npm latest checked 2026-06-22: `@anthropic-ai/claude-agent-sdk@0.3.186`

## What Current Code Does Wrong

### 1. Wrong integration boundary

`src/claudeCodeDriver/process.ts` directly calls `Bun.spawn` and manually reads Web streams. This
bypasses both the official SDK and Effect's process service (`effect/unstable/process` with
`ChildProcessSpawner` from `@effect/platform-bun`).

SDK implication: Caara should not build argv, parse JSONL, or own Claude Code subprocess stdio
unless we intentionally inject a custom SDK `spawnClaudeCodeProcess` for a later remote/sandbox
runner.

### 2. Custom Claude protocol clone

`src/claudeCodeContract/streamTypes.ts` and `streamEvents.ts` define local `Init`,
`AssistantMessage`, `TextDelta`, `ReasoningDelta`, `UserMessage`, `Result`, and `Other` events.

SDK implication: replace these with imported `SDKMessage` types:

- `SDKSystemMessage`
- `SDKAssistantMessage`
- `SDKPartialAssistantMessage`
- `SDKUserMessage`
- `SDKResultMessage`
- `SDKPermissionDeniedMessage`
- task/status/tool/auth/rate-limit messages

The current clone is already incomplete and will drift.

### 3. Runtime event model is too narrow

`src/mockResponsesProvider/agentDriver.ts` only exposes:

- `ReasoningDelta`
- `AssistantMessage`

The SDK emits much richer state:

- assistant text deltas
- thinking deltas
- tool_use starts and input_json deltas
- tool_result user messages
- permission requests/denials
- `AskUserQuestion` requests
- task started/progress/updated/notification
- status, compact boundary, API retry, auth status, rate limit, files persisted
- final result with usage/cost/model usage/permission denials/errors

Caara currently drops nearly all of that. Codex will see a shallow answer stream, not the real
agent activity.

### 4. Stream errors become successful Responses turns

`src/mockResponsesProvider/server.ts` catches driver runtime stream errors with `Stream.catch`,
logs `TurnFailed`, then drains. `responseEvents.ts` emits `response.completed` on stream halt, so a
driver failure after stream start can become a successful Codex turn and persisted session binding.

This is a correctness bug independent of SDK adoption. Runtime stream failure must result in a
Responses failure event or transport failure and must not call `completeSessionBinding`.

### 5. Response encoder is still simulator-shaped

`src/mockResponsesProvider/responseEvents.ts` hardcodes:

- response id `resp_simulator_driver`
- fixture timestamp
- item ids like `msg_simulator_0`
- one completed message item per assistant event

It does not model `output_item.added` -> content delta -> item done for assistant text, and it has
no item types for tools, permissions, tasks, status, or failures.

### 6. Prompt extraction is wrong for SDK

`src/claudeCodeDriver/prompt.ts` decodes Responses history and extracts only the latest user
`input_text`. That was a workaround for CLI `-p`.

SDK implication:

- For one-turn `query({ prompt: string })`, latest user text can work as a minimal bridge.
- For proper turn/session behavior, use `query({ prompt: AsyncIterable<SDKUserMessage> })`.
- Build typed `SDKUserMessage` from Responses input content, preserving multimodal blocks when
  supported.
- Do not replay prior assistant `output_text` as prompt; resume handles conversation continuity.
- Do not silently drop unsupported content. Fail explicitly or map it intentionally.

### 7. Cancellation is process-level and unverified

Current cancellation sends `SIGINT`, waits one second for `childProcess.exited`, then declares the
session reusable if it exited. It does not inspect SDK result state, pending permission/tool state,
or whether an SDK query was safely interrupted.

SDK implication:

- Use `Query.interrupt()` for turn cancellation.
- Use `Query.close()` for session teardown.
- Use `AbortController` only if we want a hard query abort.
- Mark reusable only after we know the SDK stream ended in an interrupted/known-safe state, or after
  policy explicitly accepts SDK interrupt as reusable.

### 8. Session persistence is under-modeled

`DurableExternalSession` stores only `externalSessionId`. Current docs call that "resume metadata
only", which is broadly right, but SDK supports a richer resume cursor:

- `resume`: Claude session id
- `resumeSessionAt`: assistant message UUID checkpoint
- `turnCount` or local bookkeeping
- optional `SessionStore` for external transcript persistence

The current binding also lacks SDK/runtime identity like Claude SDK version, Claude Code version,
cwd source, setting sources, permission mode, or whether the session used local SDK JSONL storage
vs an external `SessionStore`.

### 9. Option schema is a hand-written CLI schema

`src/claudeCodeDriver/options.ts` duplicates `effort`, `max_budget_usd`, `tools`,
`debug_file`, `include_partial_messages`.

SDK implication:

- Import `Options`, `EffortLevel`, `PermissionMode`, `ThinkingConfig`, `McpServerConfig`, etc.
- Keep Caara query params as driver-owned, but map them to SDK `Options`.
- Parse numbers as numbers where SDK expects numbers, e.g. `maxBudgetUsd`.
- Add explicit handling for settings sources, tools preset, permission mode, and dangerous bypass.

### 10. Driver registry leaks supported agents into transport

`src/mockResponsesProvider/codexTurnContext.ts` hardcodes `new Set(["claude"])`.

This blocks a clean plugin/driver registry. The transport should parse `<kind>/<specifier>`, then
ask the registry whether a driver exists.

### 11. Node/Bun direct IO leaks remain

Besides spawn, `sessionDirectory.ts` uses `node:fs/promises`, `node:path`, `node:os`, `process.env`,
and `Bun.file`. This violates the intended Effect platform boundary.

This is separable from SDK adoption, but it should be fixed soon with `FileSystem`, `Path`,
`Config`, and `Clock`/`DateTime` where applicable.

### 12. Tests encode the wrong architecture

Current Claude driver tests assert:

- fake executable argv
- fake `stream-json`
- `--session-id` / `--resume`
- stdout first-line probing

Those tests should be deleted or demoted to archived historical contract docs once SDK adapter tests
exist. They currently make the wrong design sticky.

## SDK Primitives To Use

Package state checked 2026-06-22:

- `@anthropic-ai/claude-agent-sdk@0.3.186`
- package `claudeCodeVersion`: `2.1.186`
- peer deps: `zod ^4`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`
- optional native binary deps per platform

Primary imports:

```ts
import {
  query,
  type Options as ClaudeQueryOptions,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk"
```

Core SDK surface:

- `query({ prompt, options }): Query`
- `prompt: string | AsyncIterable<SDKUserMessage>`
- `Query extends AsyncGenerator<SDKMessage, void>`
- `Query.interrupt()`
- `Query.close()`
- `Query.setModel(model?)`
- `Query.setPermissionMode(mode)`
- `Query.setMaxThinkingTokens(maxThinkingTokens | null)`
- `Query.streamInput(stream)`
- `Query.backgroundTasks(toolUseId?)`
- `Query.stopTask(taskId)`
- `Query.mcpServerStatus()`
- `Query.initializationResult()`

Useful `Options`:

- `cwd`
- `model`
- `effort`
- `thinking`
- `maxBudgetUsd`
- `tools`
- `allowedTools`
- `disallowedTools`
- `permissionMode`
- `allowDangerouslySkipPermissions`
- `canUseTool`
- `includePartialMessages`
- `resume`
- `resumeSessionAt`
- `sessionId`
- `persistSession`
- `sessionStore`
- `settingSources`
- `systemPrompt: { type: "preset", preset: "claude_code" }`
- `mcpServers`
- `env`
- `pathToClaudeCodeExecutable`
- `extraArgs`
- `abortController`
- `spawnClaudeCodeProcess`

Important changelog note: the removed v2 session API should not be used. Use `query()`, pass an
`AsyncIterable<SDKUserMessage>` for multi-turn, or `options.resume` to continue a session.

## Proposed Caara Adapter Shape

Do not copy t3code's full provider stack. Caara is currently a Responses bridge with one turn per
HTTP request. But copy the architectural split:

1. Thin SDK client wrapper, injectable in tests.
2. Claude adapter maps Caara turn/session semantics to SDK `query`.
3. Runtime event mapper maps SDK messages to Caara runtime events.
4. Responses encoder maps Caara runtime events to OpenAI Responses SSE.
5. Session directory persists resume cursor, not transcript.

Suggested files:

```text
src/claudeAgentSdkDriver/
  claudeAgentSdkClient.ts
  claudeAgentSdkOptions.ts
  claudeAgentSdkPrompt.ts
  claudeAgentSdkEvents.ts
  claudeAgentSdkDriver.ts
```

Delete or retire after migration:

```text
src/claudeCodeContract/
src/claudeCodeDriver/process.ts
src/claudeCodeDriver/driver.ts
src/claudeCodeDriver/options.ts
src/claudeCodeDriver/prompt.ts
src/claudeCodeDriver/*.test.ts
```

### Services

Use explicit Effect services instead of type-shape functions:

```ts
interface ClaudeAgentSdkClient {
  readonly query: (input: {
    readonly prompt: string | AsyncIterable<SDKUserMessage>
    readonly options: ClaudeQueryOptions
  }) => Effect.Effect<ClaudeQueryRuntime, AgentDriverError>
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>
  readonly close: () => void
  readonly setModel: (model?: string) => Promise<void>
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>
  readonly setMaxThinkingTokens: (tokens: number | null) => Promise<void>
}
```

`ClaudeQueryRuntime` is deliberately a local structural subset so tests can fake it without
depending on every SDK control method.

### Driver entrypoint

Keep the existing Caara deep entrypoint, but widen its result/event types:

```ts
interface AgentDriver {
  readonly startOrResumeTurn: (
    turn: AgentDriverTurn,
  ) => Effect.Effect<AgentDriverTurnResult, AgentDriverError>
}
```

Then change `AgentRuntimeEvent` from two text-only variants to a Caara canonical event union:

- `ThreadStarted`
- `SessionConfigured`
- `TurnStarted`
- `ContentDelta`
- `ItemStarted`
- `ItemUpdated`
- `ItemCompleted`
- `PermissionRequested`
- `PermissionResolved`
- `UserInputRequested`
- `UserInputResolved`
- `TaskStarted`
- `TaskProgress`
- `TaskCompleted`
- `TokenUsageUpdated`
- `RuntimeWarning`
- `RuntimeError`
- `TurnCompleted`

For Codex Responses v1, we can encode only the subset Codex understands, but we should retain raw
SDK payloads in the event so observability does not lose data.

## Session / Resume Mapping

### First turn

- Generate a UUID with Effect `Crypto`, not `node:crypto.randomUUID`.
- Build SDK options:
  - `cwd: preparedSession.cwd`
  - `model: turn.target.externalModelSpecifier`
  - `sessionId: generatedSessionId`
  - `systemPrompt: { type: "preset", preset: "claude_code" }`
  - `settingSources: ["user", "project", "local"]` unless user decides otherwise
  - `includePartialMessages: true`
  - mapped driver options
  - `canUseTool` policy
- Use `query({ prompt: sdkUserMessageStream, options })`.
- Persist resume cursor when the SDK emits a durable `session_id`, preferably from `system/init`
  and later `result`.

### Follow-up turn

- Load binding by `{ externalAgentKind, codexThreadId }`.
- Use persisted `cwd`.
- Pass `resume: cursor.resume`.
- If cursor includes `resumeSessionAt`, pass `resumeSessionAt`.
- Do not send prior assistant output from Responses history as prompt.
- Build a new `SDKUserMessage` only from the current user turn.

### Resume cursor schema

Replace `DurableExternalSession.externalSessionId` with a versioned driver-owned cursor:

```ts
class ClaudeAgentSdkResumeCursor extends Schema.Class("ClaudeAgentSdkResumeCursor")({
  _tag: Schema.Literal("ClaudeAgentSdk"),
  sdkVersion: Schema.optional(Schema.String),
  claudeCodeVersion: Schema.optional(Schema.String),
  sessionId: Schema.String,
  resumeSessionAt: Schema.optional(Schema.String),
  turnCount: Schema.optional(Schema.Number),
}) {}
```

Or make `DurableExternalSession` contain `resumeCursor: Schema.Unknown` plus a driver name/version.
The latter is better for future non-Claude drivers.

### Unresumable sessions

Current policy from ADR still applies:

- If SDK resume fails because session is missing/unresumable, start a fresh session.
- Return the explicit lost-context recovery assistant message.
- Update binding to fresh cursor.
- If fresh start fails, fail the transport and leave old binding unchanged.

Need implementation detail: identify SDK resume-not-found errors. Avoid brittle single regex if SDK
exposes a structured error/cause. If not structured, encapsulate matching in one function with
tests.

## Cancel / Stop Mapping

Cancellation levels:

1. Graceful turn interrupt: `Query.interrupt()`.
2. Session teardown: `Query.close()`.
3. Abort controller: only for hard abort if interrupt does not settle.

Suggested policy:

- On client disconnect, call `query.interrupt()`.
- Continue draining SDK messages until a `result` or stream end, bounded by a timeout.
- If final result is an interrupt/abort outcome, return `{ _tag: "Interrupted", sessionReusable: true }`.
- If interrupt call fails or timeout fires, call `query.close()` and return
  `{ _tag: "Terminated", sessionReusable: false }`.
- If stream failure is ambiguous, return non-reusable unless we have evidence the SDK did not commit
  hidden context.

Do not mark reusable just because a process exited.

## Tool / Permission / User Input Mapping

### Tool events

Use `SDKPartialAssistantMessage.event`:

- `content_block_start` with `tool_use`, `server_tool_use`, `mcp_tool_use` -> `ItemStarted`
- `content_block_delta` with `input_json_delta` -> `ItemUpdated`
- `SDKUserMessage` with `tool_result` content -> `ItemCompleted` or `ItemFailed`
- `SDKToolProgressMessage` -> `ToolProgress`
- `SDKToolUseSummaryMessage` -> `ToolSummary`

Store `tool_use_id`, `tool_name`, input/result, and raw SDK payload.

### Assistant / reasoning text

Use `SDKPartialAssistantMessage.event`:

- `content_block_delta.text_delta` -> assistant text `ContentDelta`
- `content_block_delta.thinking_delta` -> reasoning text `ContentDelta`
- `SDKAssistantMessage` -> fallback completed assistant item if deltas were not emitted

Keep block/index state so item ids are stable from delta start to completion.

### Permissions

Use SDK `canUseTool`:

- Full-access mode: allow and pass `allowDangerouslySkipPermissions: true` only when the caller has
  selected this mode explicitly.
- Approval-required mode: emit Caara permission request and block on a Deferred.
- `acceptForSession`: return SDK `updatedPermissions` suggestions.
- Denial/cancel: return `PermissionResult` deny with explicit message.
- `SDKPermissionDeniedMessage` should become a runtime `ToolDenied`/warning event, not disappear.

Caara currently has no Codex-facing approval input path. Short-term decision needed:

- either run Claude in non-interactive mode with restricted pre-approved tools;
- or surface permission requests as assistant text asking managing Codex to restart/approve;
- or implement a Responses-compatible approval/event convention if Codex supports one.

### AskUserQuestion

SDK's `AskUserQuestion` arrives through `canUseTool`. t3code maps it to `user-input.requested` and
waits for answer. Caara likely cannot ask the parent Codex interactively through normal Responses
today.

Short-term policy should be explicit:

- disable `AskUserQuestion`, or
- deny with "Caara subagent cannot ask interactive questions; continue with best effort", or
- map to assistant output and end the turn.

Do not leave it hanging.

## Responses Event Mapping

Minimum safe Responses mapping for next implementation:

- `response.created` once.
- assistant item:
  - `response.output_item.added`
  - `response.output_text.delta` for text deltas
  - `response.output_item.done`
- reasoning item:
  - `response.output_item.added`
  - `response.reasoning_summary_text.delta`
  - `response.output_item.done` if schema supports it
- terminal success:
  - `response.completed`
- terminal driver failure after streaming:
  - emit a Responses failure event if supported by `@effect/ai-openai` schema, otherwise abort the
    HTTP stream and do not persist completion.

Current `responseEvents.ts` should be rewritten, not patched around simulator ids.

## Tests To Replace / Add

Read `docs/agents/testing-patterns.md` before editing tests.

### Delete/replace CLI tests

Replace tests that fake a `claude` executable:

- argv construction
- first stdout line probing
- `Bun.spawn`
- `stream-json` parse details

Keep only historical contract docs if still useful.

### New unit tests

1. `claudeAgentSdkOptions.test.ts`
   - maps query params to `ClaudeQueryOptions`
   - rejects unknown params
   - parses `max_budget_usd` as number
   - maps `tools`, `allowed_tools`, `permission_mode`, `setting_sources`
   - rejects dangerous bypass unless explicitly requested

2. `claudeAgentSdkPrompt.test.ts`
   - latest user turn becomes `SDKUserMessage`
   - prior assistant output is not replayed
   - unsupported content fails explicitly
   - image/multimodal blocks mapped if supported

3. `claudeAgentSdkEvents.test.ts`
   - maps text deltas
   - maps thinking deltas
   - maps assistant snapshot fallback
   - maps tool start/input/result/progress
   - maps result success/error/usage
   - maps permission denied/status/task events

4. `claudeAgentSdkResumeCursor.test.ts`
   - captures `system/init.session_id`
   - updates `resumeSessionAt` from assistant UUID
   - persists versioned cursor
   - rejects malformed cursor

5. `responseEvents.test.ts`
   - stream failure does not emit `response.completed`
   - assistant deltas use proper lifecycle
   - stable ids are not simulator ids

### New integration-style tests

Use an injected fake `createQuery`, like t3code's `FakeClaudeQuery`, not a fake executable.

Scenarios:

- first turn starts SDK query with `sessionId`, `cwd`, `model`, `includePartialMessages`
- follow-up starts SDK query with `resume`, persisted cwd, no prior assistant prompt replay
- SDK stream emits result success -> binding completed
- SDK stream emits result error -> transport failure, binding not completed as success
- client disconnect -> `interrupt()` called, reusable only after interrupted result
- interrupt timeout -> `close()` called, binding deleted/not reusable
- unresumable resume -> fresh session + lost-context recovery reply
- createQuery throws -> 500 without leaking sensitive cause message
- permission request -> request event or chosen noninteractive policy

### Type tests

Use `tstyche` if we add adapter-facing type helpers that must stay aligned with SDK `Options` or
`SDKMessage` unions.

## Dependency Work

Add dependencies with latest compatible versions:

- `@anthropic-ai/claude-agent-sdk@0.3.186`
- peer deps:
  - `@anthropic-ai/sdk >=0.93.0`
  - `@modelcontextprotocol/sdk ^1.29.0`
  - `zod ^4`

Because this repo uses Bun:

- install with Bun
- verify `bun.lock`
- confirm optional native binary packages are installed
- decide whether compiled `bun build --compile` is in scope. If yes, use SDK `extractFromBunfs`.

## Best Order To Tackle

1. Dependency + compile spike
   - Add SDK deps.
   - Import `query`, `Options`, and `SDKMessage` in a tiny ignored experiment or focused test.
   - Confirm Bun + tsgo type resolution with peer deps.

2. Adapter test harness
   - Introduce injectable `ClaudeAgentSdkClient` / `createQuery`.
   - Add `FakeClaudeQuery`-style test helper.
   - First red tests assert SDK options, resume, cancellation calls.

3. Replace CLI driver with SDK driver
   - Implement first/follow-up turn through `query`.
   - Delete direct `Bun.spawn`, argv builder, and stream-json parser from production path.
   - Keep lost-session recovery behavior.

4. Widen Caara runtime event model
   - Add canonical item/content/tool/task/error events.
   - Map SDK messages in one module.
   - Preserve raw SDK payloads for diagnostics.

5. Fix Responses SSE encoder and failure semantics
   - Proper item lifecycle.
   - No `response.completed` on driver failure.
   - No completion persistence on stream failure.

6. Permission/user-input policy
   - Decide noninteractive vs interactive bridge.
   - Implement `canUseTool` accordingly.
   - Add tests for deny/allow/cancel behavior.

7. Session cursor schema cleanup
   - Version driver-owned cursor.
   - Store SDK session id, optional checkpoint UUID, SDK/Claude versions.
   - Keep cwd stable.

8. Effect platform IO cleanup
   - Replace remaining `Bun.file`, `node:fs/promises`, `node:os`, direct `process.env` in session
     directory/config with Effect services.
   - If custom SDK spawn is needed, implement it through `ChildProcessSpawner`; otherwise do not
     reintroduce process spawning in Caara.

9. Docs update
   - Rewrite `docs/caara.md` Claude driver section.
   - Mark `docs/agents/claude-code-contract.md` as historical CLI spike evidence or remove if no
     longer useful.
   - Add ADR if we decide `SessionStore`, permission policy, or SDK local transcript reliance.

## Open Questions / User Decisions

1. Should Caara use the SDK's default local session JSONL persistence, or provide an SDK
   `SessionStore` backed by Caara state?

   Default local persistence is faster. `SessionStore` is cleaner if Caara should own all durable
   external-agent state or support multi-host later.

2. Should Caara pass `pathToClaudeCodeExecutable` to use a user-installed Claude binary, or rely on
   the SDK bundled optional binary?

   Bundled binary reduces setup. User binary may preserve existing Claude auth/config behavior.

3. Which `settingSources` should SDK sessions load?

   SDK defaults load user/project/local settings. t3code uses `["user", "project", "local"]`.
   Passing `[]` would make Caara more hermetic but skip useful Claude project memory/config.

4. What is the permission mode for Codex-spawned subagents?

   Current smoke likely assumes Claude can read/run tools. `bypassPermissions` needs
   `allowDangerouslySkipPermissions` and should only be used when Codex sandbox semantics justify it.

5. How should interactive permission and `AskUserQuestion` be represented to managing Codex?

   This is the largest product-semantics gap. Without an answer, use an explicit noninteractive
   deny/fail policy.

6. Do we want driver residency now?

   SDK supports streaming input and in-session control, but current Caara HTTP shape starts one
   turn per request. Per-turn `query({ resume })` is simpler. Resident SDK sessions are faster and
   support `setModel`/`setPermissionMode`, but require lifecycle/reaper work.

7. Should model aliases remain opaque?

   ADR says yes. Driver can pass `externalModelSpecifier` to SDK `model` and let SDK/Claude fail.
   If we add friendly aliases or capability validation, that belongs inside Claude driver, not
   Caara core.

8. What Responses event subset does Codex actually consume for tool/task/permission events?

   We need either a real Codex smoke test or fixture evidence before exposing rich non-text events.

## Risks

- SDK version churn: changelog shows breaking changes around session APIs, MCP, and task tools.
  Keep SDK imports centralized and avoid depending on deprecated APIs.
- Bun compiled executable: SDK native binary resolution needs `extractFromBunfs` if Caara is ever
  compiled with `bun build --compile`.
- Hidden session mutation on cancellation: do not mark sessions reusable without a clear interrupt
  result.
- Permission deadlock: a `canUseTool` callback that waits for a UI path Caara does not have will
  hang the turn.
- Responses encoder mismatch: Codex may tolerate minimal text events but reject richer custom
  shapes. Validate with smoke tests.
- Existing docs are now misleading: `docs/caara.md` describes CLI behavior as v1. Update after
  implementation.

## Recommended First Task Breakdown

Task 1: Add SDK dependency and client seam.

- Add deps.
- Add `ClaudeAgentSdkClient` service.
- Add fake `ClaudeQueryRuntime` tests.
- No behavior change beyond compile.

Task 2: Implement SDK turn start/resume.

- Replace production Claude driver path.
- Preserve existing session binding and lost-session recovery policy.
- Delete CLI process usage from production.
- Tests: first turn, follow-up, create failure, result error.

Task 3: Fix stream failure semantics.

- Runtime stream errors fail the Responses turn.
- No session completion on failure.
- Tests around `Stream.fail`.

Task 4: Expand SDK event mapping and Responses lifecycle.

- Proper assistant/reasoning delta lifecycle.
- Tool/task/status/raw observability events.
- Remove simulator ids/timestamps.

Task 5: Decide and implement permission/user-input policy.

- Start noninteractive if no Codex approval path exists.
- Add explicit tests for every allow/deny/cancel branch.

Task 6: Platform IO cleanup.

- Move session directory to Effect `FileSystem`/`Path`/config services.
- Only add SDK custom spawn via Effect process if we need custom spawn.

