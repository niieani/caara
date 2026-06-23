# Session State and Driver Seam Remediation

Date: 2026-06-22

Scope: investigation only. Files reviewed:

- `src/mockResponsesProvider/agentDriver.ts`
- `src/mockResponsesProvider/sessionDirectory.ts`
- `src/mockResponsesProvider/turnConcurrency.ts`
- `src/mockResponsesProvider/codexTurnContext.ts`
- `src/mockResponsesProvider/server.ts`
- `src/mockResponsesProvider/responseEvents.ts`
- `src/claudeCodeDriver/*`
- `src/claudeCodeContract/*`
- `CONTEXT.md`
- `docs/caara.md`
- `docs/adr/*.md`
- `docs/agents/testing-patterns.md`
- `references/t3code/apps/server/src/provider/*`
- `references/t3code/packages/contracts/src/providerRuntime.ts`

External reference checked: Anthropic's `claude-agent-sdk-typescript` repository and changelog.
The package is now named `@anthropic-ai/claude-agent-sdk`; the repository describes it as the
Claude Agent SDK, formerly Claude Code SDK. Current changelog entries show `query()` as the
supported multi-turn surface, with the older v2 session API removed in `0.3.142`. Latest GitHub
release observed during this investigation: `v0.3.185` on 2026-06-20.

## Executive Summary

Current implementation is a CLI-contract adapter, not an SDK adapter.

It:

- hand-builds Claude CLI argv in `src/claudeCodeContract/invocation.ts`
- spawns with `Bun.spawn` in `src/claudeCodeDriver/process.ts`
- parses `--output-format stream-json` stdout in `src/claudeCodeContract/streamEvents.ts`
- compresses driver output into only `ReasoningDelta` and `AssistantMessage`
- persists only raw string session binding fields and a generic external session id
- treats stream errors as logged-and-drained, allowing failed turns to complete successfully

This contradicts the intended direction from the earlier design discussion: use the Claude SDK or
at least copy the SDK-backed provider/session shape from `references/t3code`.

The highest-leverage remediation is not a one-file driver swap. Caara needs a stronger domain model
for session bindings, a richer driver interface, and an SDK-backed Claude adapter that owns SDK
query lifecycle, cancellation, and resume state.

Recommended task order:

1. Fix transport failure semantics so runtime stream failures cannot emit `response.completed` or
   persist completed bindings.
2. Introduce branded domain ids and a typed session binding model.
3. Replace the driver seam with SDK-aware turn/session events and typed capability policy.
4. Add `@anthropic-ai/claude-agent-sdk` and rewrite Claude around `query()`.
5. Replace CLI-contract tests with SDK-adapter tests using injected `createQuery`.
6. Rework Responses event encoding after the runtime event model is richer.

## Current Domain Model Gaps

The glossary in `CONTEXT.md` is mostly good. The code is not enforcing it.

### Raw string identifiers

Current raw strings:

- `CodexTurnContext.parentSessionId`
- `CodexTurnContext.threadId`
- `CodexTurnContext.turnId`
- `CodexTurnContext.parentThreadId`
- `CodexTurnContext.windowId`
- `CodexTurnContext.subagentKind`
- `AgentTarget.requestedModel`
- `AgentTarget.externalAgentKind`
- `AgentTarget.externalModelSpecifier`
- `CaaraSessionBinding.codexThreadId`
- `CaaraSessionBinding.parentCodexSessionId`
- `CaaraSessionBinding.externalAgentKind`
- `CaaraSessionBinding.requestedModel`
- `CaaraSessionBinding.externalModelSpecifier`
- `DurableExternalSession.externalSessionId`
- `TurnConcurrencyKey.externalAgentKind`
- `TurnConcurrencyKey.codexThreadId`

These are domain concepts with different invariants but identical TypeScript type. That lets code
accidentally swap a Codex thread id, parent session id, external session id, or model specifier
without type friction.

Branded id opportunities:

- `CodexParentSessionId`
- `CodexThreadId`
- `CodexParentThreadId`
- `CodexTurnId`
- `CodexWindowId`
- `ExternalAgentKind`
- `RequestedAgentModelSpecifier`
- `ExternalModelSpecifier`
- `DriverOptionName`
- `DriverOptionValue`
- `ClaudeSessionId`
- generic `ExternalSessionId` only if the driver-kind discriminator is carried with it
- `CaaraSessionKey` as a Schema.Class or branded struct, not duplicated records

Use `Schema.brand(...)` with trimmed non-empty string checks. The reference pattern in
`references/t3code/packages/contracts/src/baseSchemas.ts` is a good starting point:
`ThreadId`, `TurnId`, `RuntimeItemId`, `RuntimeRequestId`, etc. are separate brands over the same
runtime string representation.

### Open versus closed driver kind

`codexTurnContext.ts` hardcodes:

```ts
const supportedExternalAgentKinds = new Set(["claude"]);
```

That makes driver availability a transport-decoder concern. The domain glossary says external
agent kind selects a driver, and ADRs say driver option schemas are driver-owned. The registry
should own availability. Core should only parse a syntactically valid kind and ask the registry to
resolve it.

Recommendation:

- Parse `ExternalAgentKind` as an open branded slug.
- Move unknown-kind failure to `AgentDriverRegistry.resolve`.
- Keep transport-edge error shape OpenAI-compatible, but not the source of truth for driver kinds.

This matches the `t3code` distinction between `ProviderDriverKind` and `ProviderInstanceId` in
`references/t3code/packages/contracts/src/providerInstance.ts`.

## Driver Seam Is Too Narrow

Current seam in `agentDriver.ts`:

```ts
startOrResumeTurn(turn) -> {
  runtimeEvents: Stream<ReasoningDelta | AssistantMessage, AgentDriverError>
  externalSession: ExternalSessionState
  cancel: Effect<AgentCancellationOutcome>
}
```

Problems:

- It cannot represent SDK session start/configuration/ready/running/stopped state.
- It cannot represent tool calls, tool results, permission requests, user-input questions, MCP
  status, subagent/task progress, token usage, model rerouting, warnings, SDK raw events, or native
  provider ids.
- It has no event ids, item ids, request ids, turn ids, provider refs, timestamps, or raw payload
  retention.
- It only models assistant text as completed messages, so partial text deltas and item lifecycle are
  collapsed too early.
- It forces the Claude adapter to throw away most SDK semantics before the Responses encoder can
  decide how to represent them.
- It puts session mutation result (`externalSession`) beside a stream whose eventual success/failure
  is separate; this contributed to the current failed-stream-can-complete bug.

The seam is shallow: callers know about start/resume/cancel/session persistence, while drivers still
expose too little of their behavior.

### Replacement shape

Caara does not need to copy all of `t3code`, but the shape should move toward a provider runtime
event model:

- `session.started`
- `session.configured`
- `session.state.changed`
- `session.exited`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `turn.interrupted`
- `item.started`
- `item.updated`
- `item.completed`
- `content.delta`
- `request.opened`
- `request.resolved`
- `user-input.requested`
- `user-input.resolved`
- `task.started`
- `task.progress`
- `task.completed`
- `thread.token-usage.updated`
- `mcp.status.updated`
- `runtime.warning`
- `runtime.error`
- `raw.sdk.message`

Minimum useful event fields:

- `eventId`
- `createdAt`
- `driverKind`
- `driverInstanceId` or binding identity
- `codexThreadId`
- `codexTurnId`
- optional `runtimeItemId`
- optional `runtimeRequestId`
- optional `providerRefs`
- `payload`
- optional `raw`

This should remain driver-neutral. Claude SDK messages are translated into Caara runtime events at
the Claude adapter, not leaked directly into core. But raw SDK payloads should be retained in
diagnostic/log events where useful.

## Binding Identity and Persistence

Current persisted binding:

```ts
class CaaraSessionBinding {
  codexThreadId: string
  parentCodexSessionId: string
  externalAgentKind: string
  requestedModel: string
  externalModelSpecifier: string
  rawDriverOptions: Record<string, string>
  externalSession: ExternalSessionState
  cwd: string
  createdFromTurnId: string
  lastTurnId: string
}
```

This is too flat for SDK semantics and future drivers.

### Needed identity split

Current key is `{ externalAgentKind, codexThreadId }`. That is acceptable for single configured
Claude instance, but insufficient once there are multiple Claude homes, binaries, API routers, or
environment profiles.

Need a separate routing/config identity:

- `externalAgentKind`: implementation family, e.g. `claude`
- `driverInstanceId` or `driverConfigIdentity`: configured adapter instance, e.g.
  `claude-default`, `claude-work`, `claude-openrouter`
- `codexThreadId`: durable subagent identity

Recommended Caara session key:

```ts
{
  externalAgentKind: ExternalAgentKind
  driverInstanceId: DriverInstanceId
  codexThreadId: CodexThreadId
}
```

For the prototype, `driverInstanceId` can default to the external agent kind. It still needs to be
in the model now so state files do not need another incompatible identity migration when multiple
Claude configurations arrive.

### Needed persisted state

Replace generic `ExternalSessionState` with driver-owned resume cursor:

```ts
type ExternalSessionState =
  | {
      _tag: "Durable"
      driverKind: ExternalAgentKind
      resumeCursor: unknown
    }
  | {
      _tag: "Ephemeral"
      reason?: string
    }
```

For Claude SDK, the cursor should not be just `externalSessionId`. It should at least include:

- Claude SDK session id / `resume`
- optional resume checkpoint/assistant UUID if SDK exposes it
- observed SDK version or Claude Code version if available
- selected Claude home/binary/config identity
- session creation/update timestamps
- maybe turn count / last completed Codex turn id

The `t3code` Claude adapter stores a cursor shaped like:

```ts
{
  threadId,
  resume,
  resumeSessionAt,
  turnCount
}
```

Caara can start smaller, but should preserve an opaque driver-owned object rather than freezing the
schema around one string.

### Runtime payload

Persist mutable runtime payload separately from identity and resume:

- `cwd`
- last selected model / external model specifier
- parsed driver options or model selection
- active turn id
- last runtime event type/time
- last error summary
- session status

The `t3code` `ProviderSessionDirectory` persists `resumeCursor` and `runtimePayload` separately and
merges payload updates. That is the right pattern.

## Option and Model Change Policy

Current ADR says driver option changes should be passed to the driver and drivers that cannot apply
changed options should log a warning and keep the existing external session.

Code currently:

- stores `requestedModel`, `externalModelSpecifier`, and `rawDriverOptions`
- passes `previousTarget` to driver
- Claude driver ignores change policy except by building CLI args for each process invocation

With the SDK, option/model changes are not all equivalent.

Recommended explicit policy:

- Driver declares capabilities:
  - `modelSwitch: "in-session" | "restart-session" | "unsupported"`
  - `optionSwitch: Record<optionName, "in-session" | "next-turn" | "restart-session" | "unsupported">`
  - `resume: "durable" | "ephemeral"`
  - `cancellation: "interrupt" | "close" | "abandon"`
- Session binding records the applied target, not only requested target.
- On incoming target change:
  - If SDK can apply in-session, apply it explicitly and emit `session.configured` or
    `model.rerouted`.
  - If change only applies to future query startup, keep current session and emit a
    `config.warning`.
  - If change requires restart and session durability is safe, close/start with same resume cursor
    or a documented fresh-session recovery flow.
  - If unsupported, hard-fail or explicit warning depending on whether the option is required.

For Claude SDK:

- `setModel(model)` exists on the SDK query runtime in `t3code` and should be used for model
  changes.
- `setPermissionMode(...)` exists and maps to interaction mode.
- `setMaxThinkingTokens(...)` exists in the reference runtime shape.
- Effort/thinking/fast-mode/settings may be startup-only or SDK-option-specific; verify against the
  installed SDK docs before implementation.

Do not leave option-change behavior implicit in argv generation.

## Concurrency and Cancellation State Model

Current `TurnConcurrency` is process-local:

```ts
Map<`${externalAgentKind}:${codexThreadId}`, turnId>
```

It protects one process from overlapping turns, but:

- no persisted `activeTurnId`
- no lifecycle status in session binding
- no cleanup if process dies mid-turn
- no distinction between active SDK session and active turn
- no cross-process locking if two Caara processes share state dir
- cancellation result is detached from stream success/failure

Recommended state model:

- Session states: `starting`, `ready`, `running`, `waiting`, `stopping`, `stopped`, `error`
- Turn states: `accepted`, `starting`, `running`, `waiting_for_permission`, `completed`,
  `failed`, `interrupted`, `abandoned`
- Persist `activeTurnId` in runtime payload when a turn starts.
- Clear `activeTurnId` only after terminal turn event.
- On process startup, inspect stale `activeTurnId` and mark `interrupted`/`unknown` in logs before
  accepting new work.
- Keep process-local concurrency guard for now, but plan file lock or SQLite row lock if multiple
  Caara processes can share `CAARA_STATE_DIR`.

### Cancellation

Current Claude cancellation:

- sends `SIGINT`
- waits 1 second
- reports `Interrupted` if process exits, else `Abandoned`

SDK-backed cancellation should use SDK controls:

- active turn interrupt: `query.interrupt()`
- session disposal: `query.close()`
- prompt queue termination if using long-lived async prompt iterable
- pending permission/user-input deferrals resolved as cancelled

Cancellation outcomes should be tied to observed SDK terminal events:

- `Interrupted`: SDK reports interrupted result or stream interruption and no hidden work can
  mutate durable context.
- `Abandoned`: Caara stopped relaying while SDK may continue or outcome is unknown.
- `Closed`: SDK session was closed and resume state should not be reused unless SDK guarantees
  persisted state.
- `Failed`: interrupt/close itself failed.

Avoid declaring session reusable solely because a process exited or `interrupt()` resolved. Require
evidence from SDK result/session state where available.

## Critical Current Bug: Failed Stream Can Complete

In `server.ts`, driver stream errors are handled like this:

```ts
Stream.catch((error) =>
  Stream.drain(Stream.fromEffect(relayLogger.log({ _tag: "TurnFailed", ... })))
)
```

That catches the error and turns it into an empty successful stream. Then
`responseEvents.ts` appends `response.completed` on stream halt success, and `finalizeTurn` runs
`completeTurn`, persisting the binding as completed.

Impact:

- Runtime driver failures after `startOrResumeTurn` can produce successful Responses streams.
- Session bindings can advance `lastTurnId` after failed work.
- Codex may believe subagent work completed with partial/no output.

This should be remediated before the SDK rewrite or as the first slice of it.

Expected behavior:

- Stream failure emits a Responses error event or fails the HTTP stream according to the chosen
  Responses compatibility contract.
- `response.completed` is not emitted after a runtime failure.
- `completeSessionBinding` is not called after a runtime failure.
- Relay log has `TurnFailed`, and persisted binding is unchanged except explicit failure metadata
  if added.

## Effect Platform and IO Boundary

Current code uses direct platform APIs in runtime modules:

- `Bun.spawn` in `src/claudeCodeDriver/process.ts`
- `Bun.file`, `node:fs/promises`, `node:path`, `node:os`, `process.env` in
  `src/mockResponsesProvider/sessionDirectory.ts`
- `randomUUID` in `src/claudeCodeDriver/driver.ts`

For the existing CLI path, process spawn should have used `effect/unstable/process` and
`@effect/platform-bun`. With SDK, Caara may not spawn directly, but IO should still sit behind
Effect services:

- `FileSystem`
- `Path`
- `ConfigProvider` / `Config`
- `Crypto`
- SDK query factory injection

This matters for tests and future driver instances. The SDK adapter should accept `createQuery` as
a dependency, like `t3code` does, so tests do not start real Claude.

## Responses Encoding

Current encoder is still simulator-shaped:

- hardcoded `resp_simulator_driver`
- fixture timestamp
- generated item ids like `msg_simulator_0`
- assistant message events are emitted only as `response.output_item.done`
- no `response.output_item.added` / text delta lifecycle for assistant content
- reasoning creates a new reasoning item for each delta

After the runtime event model is fixed, map canonical events to Responses events:

- `turn.started` -> `response.created` once per turn
- `item.started` -> `response.output_item.added`
- `content.delta` with `assistant_text` -> text delta event
- `content.delta` with `reasoning_text` / `reasoning_summary_text` -> reasoning delta event
- `item.completed` -> `response.output_item.done`
- terminal successful turn -> `response.completed`
- terminal failed turn -> Responses error event or stream failure, not completed

Need one stateful encoder that accumulates output items by stable runtime item id.

## Tests to Add or Replace

Follow `docs/agents/testing-patterns.md`: unit tests for pure schemas/parsers; integration tests for
persistence, protocol, process/session lifecycle; causal observations instead of sleeps.

### Replace CLI-contract tests

Current tests under `src/claudeCodeContract/*` and much of `src/claudeCodeDriver/*` validate the
wrong architecture:

- argv construction
- JSONL stdout parser
- fake executable process behavior
- SIGINT timeout behavior

Keep only if a CLI fallback remains. Otherwise delete with the implementation.

### New domain tests

Add type/runtime schema tests for:

- branded ids reject empty/whitespace values
- `CodexThreadId` cannot be assigned to `ExternalSessionId` in type tests
- model specifier parse returns open `ExternalAgentKind` plus opaque `ExternalModelSpecifier`
- registry, not decoder, rejects unknown driver kind
- session key includes driver instance/config identity

Use `*.tst.ts` with `tstyche` for type-level brand protection.

### New session directory tests

Add/replace tests for:

- persists `resumeCursor` as opaque driver-owned JSON
- persists runtime payload separately from identity
- preserves binding identity across model/option changes
- updates applied target only after driver acknowledges configuration
- does not advance `lastCompletedTurnId` on runtime stream failure
- stores/clears `activeTurnId`
- restart reads stale active turn state and exposes explicit recovery/error state
- rejects invalid persisted binding shape explicitly

### New driver seam tests

Use a fake SDK query runtime with injected `createQuery`, matching the approach in
`references/t3code/apps/server/src/provider/Layers/ClaudeAdapter.test.ts`.

Cover:

- first turn calls `query({ prompt: AsyncIterable<SDKUserMessage>, options })`
- follow-up turn uses `options.resume`
- user input is built as `SDKUserMessage`, preserving multimodal blocks where supported
- SDK assistant stream messages emit item/content lifecycle events
- SDK reasoning deltas emit reasoning content events
- SDK result success emits terminal turn completed
- SDK result interrupted emits terminal turn interrupted
- SDK result error emits terminal turn failed
- SDK tool calls/tool results map to item lifecycle events
- SDK permission callback maps to `request.opened` / `request.resolved`
- SDK AskUserQuestion maps to `user-input.requested` / `user-input.resolved`
- `interrupt()` is called on cancellation
- `close()` is called on session disposal/finalizer
- pending approvals/user inputs are resolved cancelled on interruption
- `setModel()` is called for in-session model changes
- unsupported option changes emit warning or fail according to capability policy

### New transport integration tests

Using simulator or SDK fake, add outer-seam tests:

- runtime stream failure does not emit `response.completed`
- runtime stream failure does not call `completeSessionBinding`
- completed turn persists new resume cursor
- interrupted reusable turn persists only when SDK evidence says reusable
- non-reusable cancellation deletes or marks binding unusable
- overlapping turn rejects while active turn is running
- post-restart stale active turn state is handled explicitly

## Open Questions and Risks

1. What is the exact Caara target for Claude SDK version? Latest observed release is `v0.3.185` on
   2026-06-20, but implementation should verify with `bun pm view`/official docs at the time of
   adding the dependency.
2. Should Caara preserve a CLI fallback? Recommendation: no, unless there is a concrete SDK blocker.
   Keeping both paths will split tests and preserve wrong semantics.
3. Should `driverInstanceId` be user-configurable now or default-only until multiple Claude homes
   exist? Recommendation: add the type and persistence field now, expose config later.
4. What Responses event shapes does Codex actually require for tool/permission events? Need a
   small compatibility probe before exposing rich events to Codex.
5. Does Claude SDK guarantee durable session persistence after `interrupt()`? Need contract tests
   against the real SDK, probably manual/smoke, before marking interrupted sessions reusable.
6. Does SDK `Options.env` replace or merge `process.env`? Changelog notes it replaces the subprocess
   environment when supplied; implementation must merge intentionally if needed.
7. How should Caara handle model/option changes that SDK cannot apply in-session? Need an ADR-level
   policy because current ADR says "log warning and continue", but some options may be semantically
   required.
8. Does Caara need multiple process safety for `CAARA_STATE_DIR`? Current guard is process-local.
   If two Caara processes are plausible, use SQLite/file locks before relying on active-turn state.
9. How much raw SDK payload can relay logs retain without leaking sensitive data? Need an
   observability policy before logging full raw events by default.
10. Should `CONTEXT.md` add terms for `driver instance`, `resume cursor`, `runtime payload`, and
    `active turn`? User requested only this remediation doc, so no glossary edits were made.

## Proposed Work Breakdown

### Slice 1: Failure semantics

Goal: failed runtime stream cannot complete a Responses turn.

Tasks:

- Add regression test where driver starts successfully then runtime event stream fails.
- Change server/encoder finalization so stream failure is terminal failure, not drain success.
- Ensure binding is not completed on stream failure.
- Decide Responses-compatible error frame versus abrupt stream failure.

### Slice 2: Domain ids and session binding v2

Goal: make session identity and mutable runtime state explicit.

Tasks:

- Add branded id schemas.
- Replace raw string fields in `CodexTurnContext`, `AgentTarget`, `CaaraSessionBinding`,
  `TurnConcurrencyKey`.
- Add `driverInstanceId` to key/binding with default value.
- Replace `externalSessionId` string with opaque `resumeCursor`.
- Split persisted binding into identity, applied target, resume state, runtime payload.
- Update tests and docs.

### Slice 3: Driver seam v2

Goal: expose SDK-capable runtime events and capability policy.

Tasks:

- Replace `AgentRuntimeEvent` with canonical lifecycle event union.
- Add driver capabilities.
- Replace fake type-shape functions with explicit method types.
- Move unknown driver-kind resolution into registry.
- Update simulator driver to emit lifecycle events.
- Update Responses encoder to consume lifecycle events.

### Slice 4: Claude SDK adapter

Goal: no hand-built Claude CLI argv/stdout protocol.

Tasks:

- Add `@anthropic-ai/claude-agent-sdk`.
- Remove/retire `src/claudeCodeContract/*` unless kept only for historical probes.
- Build SDK `createQuery` dependency seam.
- Implement prompt queue with `AsyncIterable<SDKUserMessage>`.
- Map SDK messages to lifecycle events.
- Persist SDK resume cursor.
- Implement `interrupt()`, `close()`, model switch, permission callbacks.
- Use Effect services for config/fs/path/crypto and SDK query factory.

### Slice 5: Transport fidelity

Goal: Responses stream reflects richer runtime events safely.

Tasks:

- Implement stable item/request id mapping.
- Emit assistant text deltas and item lifecycle.
- Emit reasoning lifecycle correctly.
- Decide representation for tool/progress/permission events that Codex will accept.
- Add compatibility smoke flow against Codex subagent behavior.

### Slice 6: Cleanup

Goal: remove legacy paths and wrong tests.

Tasks:

- Delete CLI driver/process/contract code if SDK path is complete.
- Delete argv/stdout tests.
- Update `docs/caara.md`, ADRs, and `CONTEXT.md` with final terms and decisions.
- Run focused tests, typecheck, lint, and manual smoke.

