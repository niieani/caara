# Caara

Caara is a Codex subagent bridge for running external code agents while Codex still speaks the
Responses-compatible subagent transport it already supports.

The current v1 implementation supports Claude Code through the Claude Agent SDK, Antigravity
through the `agy` CLI, and an always-available Diagnostic driver for smoke testing. Codex sends a
normal streaming `POST /v1/responses` request to Caara, Caara resolves
`model = "<external-agent>/<external-model>"`, starts or resumes the matching driver session, and
relays normalized runtime events back as OpenAI Responses SSE events.

## Current Behavior

Caara serves `POST /v1/responses` on `http://127.0.0.1:8787`.

Supported request shape:

- `model`: required string in `<external-agent-kind>/<external-model>` form.
- `input`: required JSON value.
- `stream`: must be `true`.
- Codex identity headers and `x-codex-turn-metadata`: validated before driver code runs.
- Provider query parameters: passed as driver-owned options.

Implemented external agent kinds:

- `claude/*`: routed to the Claude Agent SDK driver.
- `agy/*`: routed to the Antigravity CLI driver.
- `diagnostic/*`: routed to the always-available Diagnostic driver.

For each valid streaming turn, Caara:

- decodes Codex turn identity and workspace context at the transport boundary
- resolves the requested model into an agent target
- prepares or loads a session binding keyed by external agent kind and Codex thread id
- starts or resumes an external agent session in the resolved working directory
- maps external agent output into normalized runtime events
- encodes runtime events as OpenAI Responses SSE frames
- persists updated session metadata after successful turns
- cancels in-flight driver work when the Codex response stream disconnects

Malformed requests, unsupported model strings, conflicting required identity, missing working
directory, invalid driver options, and unrecoverable driver failures fail explicitly.

## Codex Turn Context

Codex turn context decoding is isolated from HTTP routing and driver logic. The decoder owns:

- Effect Schemas for Codex request headers, `client_metadata`, and `x-codex-turn-metadata`.
- JSON parsing for `x-codex-turn-metadata`.
- URL query parsing for provider query parameters.
- Duplicate-field invariants across headers, body metadata, and turn metadata.
- Working-directory candidate extraction.
- Explicit hard failures for missing or conflicting required Codex identity.

Decoded shape:

```ts
class CodexTurnContext extends Schema.Class("CodexTurnContext")({
  parentSessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  parentThreadId: Schema.String,
  windowId: Schema.String,
  requestKind: Schema.Literal("turn"),
  subagentKind: Schema.String,
  originator: Schema.String,
  requestedModel: Schema.String,
  advisoryEffort: Schema.optional(Schema.Union([
    Schema.Literal("low"),
    Schema.Literal("medium"),
    Schema.Literal("high"),
    Schema.Literal("xhigh"),
  ])),
  sandboxPosture: Schema.Union([Schema.Literal("none"), Schema.Literal("enforced")]),
  workspacePaths: Schema.Array(Schema.String),
  cwdCandidates: Schema.Array(Schema.String),
}) {}
```

Required raw header shape:

```ts
const CodexRequestHeaders = Schema.Struct({
  "session-id": Schema.String,
  "thread-id": Schema.String,
  "x-client-request-id": Schema.String,
  "x-codex-parent-thread-id": Schema.String,
  "x-codex-turn-metadata": Schema.String,
  "x-codex-window-id": Schema.String,
  "x-openai-subagent": Schema.String,
  originator: Schema.String,
});
```

Required turn metadata shape:

```ts
const CodexTurnMetadata = Schema.Struct({
  installation_id: Schema.String,
  session_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
  window_id: Schema.String,
  request_kind: Schema.Literal("turn"),
  parent_thread_id: Schema.String,
  subagent_kind: Schema.String,
  sandbox: Schema.String,
  workspaces: Schema.optional(Schema.Record(Schema.String, codexWorkspaceMetadataSchema)),
  turn_started_at_unix_ms: Schema.Finite,
});
```

Decoder invariants:

- Header `thread-id` must equal turn metadata `thread_id`.
- Header `session-id` must equal turn metadata `session_id`.
- Header `x-codex-parent-thread-id` must equal turn metadata `parent_thread_id`.
- Header `x-codex-window-id` must equal turn metadata `window_id`.
- Body `client_metadata.thread_id`, if present, must equal header `thread-id`.
- Body `client_metadata.turn_id`, if present, must equal turn metadata `turn_id`.
- Body `model` must be a non-empty string.
- Provider query parameters must not contain duplicate keys.

Real Codex has been observed to send `x-openai-subagent = "collab_spawn"` while turn metadata
contains `subagent_kind = "thread_spawn"`. Caara treats validated metadata as the durable subagent
kind and does not require that header to match metadata.

Codex-specific headers and `x-codex-turn-metadata` are the authoritative source for turn identity.
`client_metadata` is duplicate body-level context for validation, not route selection.

## Codex Advisory Signals

Caara decodes Codex-provided advisory signals at the transport edge and exposes them on
`AgentDriverTurn.codex` for driver-owned fallback mapping:

- `reasoning.effort` becomes optional advisory effort `low | medium | high | xhigh`.
- `x-codex-turn-metadata.sandbox` becomes sandbox posture `none` when the metadata value is
  `none`, otherwise `enforced`.

Advisory signals are not global Caara policy. Driver query params stay highest precedence for the
same behavior. For Claude, `query_params.effort` supersedes Codex advisory effort and remains the
way to request Claude-only `max`. For Antigravity, `query_params.sandbox` supersedes Codex sandbox
posture.

## Agent Target Selection

Caara selects the external agent target from `body.model`, not from the URL path. A single Codex
model provider can point at one Caara base URL, and each Codex custom agent can choose a different
`model` string.

Model specifier shape:

```text
<external-agent-kind>/<external-model>
```

Examples:

```text
claude/haiku
claude/sonnet
claude/opus
diagnostic/basic
diagnostic/activity
```

Caara core parses only the first `/`. The segment before it selects the external agent kind and its
driver. The rest is an opaque external model specifier passed to the driver as-is; Caara core does
not keep a model allow-list because external harnesses may add or expose arbitrary model names.
Unknown external agent kinds or model strings without an agent-kind prefix fail explicitly.

Provider query parameters become driver options. Caara parses them generically and does not reserve
global option names or require option prefixes. The selected external agent kind scopes the option
names, so `effort` can mean different things for different drivers.

Selected target shape:

```ts
interface AgentTarget {
  readonly requestedModel: string;
  readonly externalAgentKind: string;
  readonly externalModelSpecifier: string;
  readonly rawDriverOptions: Record<string, string>;
}
```

## Current-Turn Input Normalization

Caara normalizes `body.input` once at the core transport-to-driver boundary before dispatching to
any external-agent driver. Real Codex Desktop subagent turns include mixed Responses input:

- Codex/developer instructions as a `developer` message.
- Repository instructions and `<environment_context>` as a setup `user` message.
- The actual managing-agent request as the current `user` message.

Drivers receive only the normalized current managing-agent user request. They do not parse or filter
raw Codex developer context, AGENTS.md prelude text, environment context, assistant history, or tool
output. A turn that contains only developer/prelude context fails explicitly instead of treating that
setup text as the delegated task. If the latest user-like message is Codex setup/prelude context,
normalization fails rather than falling back to an older user request.

Developer context and AGENTS/environment user context are intentionally ignored because external
code agents read repository instructions and environment through their own native harness when
started in the workspace. Duplicating that context in the delegated task prompt makes the prompt
noisy and can change the task semantics.

Driver-specific prompt mappers still own content validation after normalization. For example, a
driver may accept text and path-based files while explicitly rejecting unsupported current-turn
content.

## Claude Agent SDK Driver

The Claude Agent SDK driver is one real external-agent driver in v1.

Driver options accepted from provider query parameters:

- `effort`
- `max_budget_usd`
- `tools`
- `allowed_tools`
- `disallowed_tools`
- `include_partial_messages`
- `permission_mode` (`permission-mode` is also accepted as a Claude CLI-style alias)
- `activity`

Unsupported option names and invalid option values fail the turn explicitly.

`permission_mode` defaults to `dontAsk`. Accepted values are `auto`, `dontAsk`, and
`bypassPermissions`; interactive Claude SDK modes are rejected. When `bypassPermissions` is used,
the driver also sets the SDK's explicit dangerous-bypass opt-in.

For a first turn, the driver starts an SDK `query()` with a generated durable session id. For a
follow-up turn, it passes the stored Claude SDK resume cursor to `query()`. The prompt extractor
maps the core-normalized current user request into the Claude SDK prompt stream.

Current-turn input mapping:

- `input_text` becomes SDK text content.
- `input_image.image_url` becomes SDK image content for data URLs and HTTP(S) URLs.
- `input_file.file_path` / `input_file.path` becomes explicit workspace-file text when the path is
  addressable from the driver cwd.
- Opaque `file_id` content and unknown content item types fail explicitly.

Caara does not hand-build Claude CLI argv or parse Claude stdout for normal turns. Claude Agent SDK
messages are translated into Caara runtime events. Assistant text becomes `phase: "final_answer"`;
displayable reasoning stays on the reasoning-summary path; SDK tool, tool-result, task, and
progress activity becomes terse `phase: "commentary"` assistant messages by default. `activity=off`
keeps that activity lifecycle in relay logs while hiding commentary from the Codex-visible
Responses stream. Permission denials and terminal SDK results stay behind the driver/runtime
boundary. Terminal SDK failures become driver errors.

## Diagnostic Driver

The Diagnostic driver is a first-class Caara driver for smoke-testing Caara behavior without
invoking an external agent. It is always available on localhost and selected with
`model = "diagnostic/<scenario>"`.

Supported v1 scenario names:

- `diagnostic/basic`
- `diagnostic/reasoning`
- `diagnostic/activity`
- `diagnostic/fails-before-output`
- `diagnostic/fails-after-partial`
- `diagnostic/hangs-until-cancel`
- `diagnostic/recovery`
- `diagnostic/echo`

`diagnostic/basic` emits deterministic assistant output, persists an opaque Diagnostic driver
resume cursor, and returns distinct resumed output on follow-up turns for the same Codex thread.
Driver-owned options are bounded:

- `diagnostic_answer_text`
- `diagnostic_chunk_count`
- `diagnostic_delay_ms`

`diagnostic/activity` emits milestone-level assistant commentary messages with
`phase: "commentary"` followed by a final assistant message with `phase: "final_answer"`. It does
not emit Responses function-call, custom-tool, tool-output, custom-item, annotation, raw payload,
stdout, stderr, or JSON activity items. `diagnostic_activity=off` keeps the activity runtime
lifecycle in relay logs while hiding commentary from the Codex-visible Responses stream.

`diagnostic/echo` emits a deterministic final answer summarizing the normalized current user message
content received by the Diagnostic driver. Prior assistant/tool history is ignored by the shared
core normalizer before driver dispatch. The driver fails explicitly for unsupported, malformed, or
non-normalized current-turn content.

`diagnostic/recovery` emits Caara's standard lost-session recovery prompt as a final-answer
assistant message, records lost-continuity diagnostics, and updates the binding to a fresh
Diagnostic resume cursor. `diagnostic_fresh_start=failure` forces the unrecoverable failure path for
smoke testing.

Unsupported Diagnostic option names, invalid option values, and unknown scenarios fail explicitly.
The retired simulator driver and `simulator_*` query options are not part of the public or test
interface.

## Session Directory

Caara persists a session binding keyed by external agent kind and Codex thread id. Codex thread id
is stable across follow-up turns for one subagent; parent session id is shared by multiple subagents
and is not a Caara session key. Requested model and driver options are mutable desired state for that
driver binding, not durable identity.

Session bindings live in Caara's user-state directory, not in the project repository. They contain
external session ids and runtime state that should survive Caara restarts but should not become
source-controlled project artifacts.

The session directory stores resume metadata only. Caara does not persist transcripts or event
replay state; durable external agents own their own conversation durability. Relay logs are
observability records, not a source of truth for resuming or replaying a session.

State directory resolution:

1. Use `CAARA_STATE_DIR` when set.
2. Else use `$XDG_STATE_HOME/caara`.
3. Else use `$HOME/.local/state/caara`.

Session directory path:

```text
<caara-state-dir>/sessions
```

Durable identity:

```ts
interface CaaraSessionKey {
  readonly externalAgentKind: string;
  readonly codexThreadId: string;
}
```

Session binding shape:

```ts
type ExternalSessionState =
  | { readonly _tag: "Durable"; readonly externalSessionId: string }
  | { readonly _tag: "Ephemeral" };

interface CaaraSessionBinding {
  readonly codexThreadId: string;
  readonly parentCodexSessionId: string;
  readonly externalAgentKind: string;
  readonly requestedModel: string;
  readonly externalModelSpecifier: string;
  readonly rawDriverOptions: Record<string, string>;
  readonly externalSession: ExternalSessionState;
  readonly cwd: string;
  readonly createdFromTurnId: string;
  readonly lastTurnId: string;
}
```

For an existing binding, incoming requested model and raw driver options are compared with the
persisted binding. If they differ, Caara passes desired target state and previous target state to the
driver.

Working-directory resolution:

1. Use persisted cwd for an existing Codex thread.
2. Else use the first path from `x-codex-turn-metadata.workspaces`.
3. Else use validated cwd candidates extracted from the body.
4. Else fail explicitly; external code agents need a working directory.

## Session Recovery

If Claude Code cannot resume the external session id stored in a binding, Caara keeps the Codex turn
flow alive when Claude Code can start a fresh external session. Caara updates the binding to the
fresh external session id and returns a normal assistant message asking the managing agent to provide
lost context and restate the question.

Recovery message:

```text
I couldn't resume the previous external agent session, so I lost the prior context of this subagent conversation. Please send me the relevant past context and restate the question.
```

This is a normal agent reply, not a transport error. Caara does not silently continue as if old
context were present.

If Claude Code can neither resume the stored session nor start a fresh session, Caara fails the turn
with an OpenAI-shaped transport error and leaves the existing binding unchanged for inspection.

## Turn Concurrency

Caara allows at most one in-flight turn per session key. Overlapping turns for the same
`{ externalAgentKind, codexThreadId }` are treated as a protocol anomaly.

Caara rejects the overlapping turn and logs a relay event with the session key, incoming turn id, and
already-running turn id. It does not queue the turn and does not drive one external agent session
concurrently.

## Turn Cancellation

If Codex disconnects the Responses SSE stream while a turn is in flight, Caara treats the disconnect
as turn cancellation. Caara asks the selected driver to cancel the current turn and logs the
cancellation with the session key, turn id, outcome tag, and session reusability.

The Claude Code driver sends `SIGINT` to the process. If the process exits within the cancellation
timeout, the driver reports `Interrupted` and keeps the session reusable. If the process does not
settle, the driver reports `Abandoned` with `sessionReusable = false`. Process-level failures during
cancellation report `Terminated`.

Turn abandonment means Caara stops relaying to Codex while the external harness may continue running.
This is not safe cancellation by itself. If abandoned work can mutate a durable external session in a
way Codex never observes, the driver marks the session not reusable so Caara does not resume into
hidden context.

## Driver Seam

Drivers expose one deep entrypoint for a Codex turn, not separate public start/resume/send lifecycle
operations.

Driver-facing turn shape:

```ts
interface AgentDriverTurn {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
  readonly prompt: AgentTurnInput;
  readonly cwd: string;
  readonly previousTarget: AgentTarget | undefined;
  readonly externalSession: ExternalSessionState | undefined;
}
```

Runtime events:

```ts
type AgentRuntimeEvent =
  | { readonly _tag: "ReasoningDelta"; readonly text: string }
  | { readonly _tag: "AssistantMessage"; readonly text: string };
```

Cancellation outcome:

```ts
type AgentCancellationOutcome =
  | { readonly _tag: "Interrupted"; readonly sessionReusable: true }
  | { readonly _tag: "Abandoned"; readonly sessionReusable: boolean }
  | { readonly _tag: "Terminated"; readonly sessionReusable: false };
```

Driver result:

```ts
interface AgentDriverTurnResult {
  readonly runtimeEvents: Stream.Stream<AgentRuntimeEvent, AgentDriverError>;
  readonly externalSession: ExternalSessionState;
  readonly cancel: () => Effect.Effect<AgentCancellationOutcome, never>;
}
```

Driver interface:

```ts
interface AgentDriver {
  readonly startOrResumeTurn: (turn: AgentDriverTurn) => Effect.Effect<AgentDriverTurnResult, AgentDriverError>;
}
```

The driver implementation owns process lifecycle and external agent session ids. The caller owns
target selection, Codex turn context decoding, session binding persistence, concurrency control, and
relaying normalized runtime events onto the Responses transport.

## Codex Role Configuration

The local Codex roles live at `.codex/agents/caara-claude.toml` and
`.codex/agents/caara-antigravity.toml`. Each role file is self-contained: it includes both the
agent config and the `[model_providers.caara]` provider block.

The provider block is intentionally embedded in the role file because Codex validates role config
layers before merging project-level provider config.

Current local Claude role:

```toml
name = "caara-claude"
description = "Delegates to the local Caara Responses provider backed by Claude Code."
developer_instructions = "Use the local Caara Responses provider. Relay the provider response as-is."
model_provider = "caara"
model = "claude/haiku"
model_supports_reasoning_summaries = true

[model_providers.caara]
name = "Caara Responses"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

Current local Antigravity role:

```toml
name = "caara-antigravity"
description = "Delegates to the local Caara Responses provider backed by Antigravity."
developer_instructions = "Use the local Caara Antigravity driver. Relay the provider response as-is."
model_provider = "caara"
model = "agy/gemini-3.5-flash"
model_supports_reasoning_summaries = true

[model_providers.caara]
name = "Caara Responses"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

`model_supports_reasoning_summaries = true` lets Codex serialize the current dynamic effort
selector to Caara as request body `reasoning.effort`. Do not add `model_reasoning_effort` unless a
role intentionally pins fixed effort; that setting overrides dynamic selector behavior.

`query_params` is a model-provider setting in Codex. Caara receives those parameters on the
`/v1/responses` request URL and treats them as driver options. Driver query params override
comparable Codex advisory signals.

Example with Claude Code options:

```toml
[model_providers.caara]
name = "Caara Responses"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
query_params = { effort = "high", max_budget_usd = "1", permission_mode = "auto" }
```

Use `query_params.effort` for an explicit Claude effort override. It wins over Codex
`reasoning.effort`, and it is the only way to request Claude-only `max`.

## Effect Usage

The HTTP server is built on Effect v4 and `@effect/platform-bun`.

SSE framing uses Effect's native `effect/unstable/encoding/Sse` encoder. Tests decode streamed bytes
with the same Effect SSE decoder and validate payloads against
`@effect/ai-openai/OpenAiSchema.ResponseStreamEvent`.

## Validation

Primary checks:

```bash
bun run fmt
bun lint
bun run typecheck
bun run test --run
```

Manual Codex subagent smoke testing is documented in `docs/agents/smoke-testing.md`.
