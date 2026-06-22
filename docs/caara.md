# Caara

Caara is a Codex subagent bridge for running external code agents while Codex still speaks the
Responses-compatible subagent transport it already supports.

The current implementation is a local placeholder that proves the Codex role and Responses
transport wiring before connecting a real external agent such as Claude Code or Antigravity.

## Current Behavior

Caara serves `POST /v1/responses` on `http://127.0.0.1:8787`.

Supported request shape:

- `model`: required string
- `input`: required JSON value
- `stream`: must be `true`

For every valid request, Caara:

- logs request diagnostics and request `input`
- streams OpenAI Responses SSE events
- emits fake reasoning text: `thinking how best to respond`
- emits final assistant text: `Yes, the mock subagent seems to be working`
- ends with `response.completed`

Malformed requests and non-streaming requests fail explicitly with an OpenAI-shaped `invalid_request_error`.

## Planned Architecture

The Responses transport is only the Codex-facing outer shape. Caara should decode Codex-specific
metadata, the requested model, and provider query parameters into a compact `CodexTurnContext`,
resolve an `AgentTarget`, drive a driver, and relay normalized agent runtime events back as
Responses SSE.

### Codex Turn Context

Codex turn context decoding should be its own deep module, separate from both HTTP routing and
drivers.

Recommended interface:

```ts
decodeCodexTurnContext({ headers, url, body }) -> CodexTurnContext
```

The module owns:

- Effect Schemas for Codex request headers, `client_metadata`, and `x-codex-turn-metadata`.
- JSON parsing for `x-codex-turn-metadata`.
- URL query parsing for provider query parameters.
- Duplicate-field invariants across headers, body metadata, and turn metadata.
- Working-directory candidate extraction.
- Explicit hard failures for missing or conflicting required Codex identity.

Suggested decoded shape:

```ts
class CodexTurnContext extends Schema.Class("CodexTurnContext")({
  parentSessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  windowId: Schema.String,
  requestKind: Schema.Literal("turn"),
  subagentKind: Schema.String,
  originator: Schema.String,
  requestedModel: Schema.String,
  providerQueryParams: Schema.Record({ key: Schema.String, value: Schema.String }),
  workspacePaths: Schema.Array(Schema.String),
  cwdCandidates: Schema.Array(Schema.String),
}) {}
```

Suggested raw header schema:

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

Suggested turn metadata schema:

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
  workspaces: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        latest_git_commit_hash: Schema.String,
        has_changes: Schema.Boolean,
      }),
    }),
  ),
  turn_started_at_unix_ms: Schema.Number,
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

Codex-specific headers and `x-codex-turn-metadata` are the authoritative source for turn identity.
`client_metadata` is a duplicate body-level observation used for validation and captured context,
not route selection.

### Agent Target Selection

Caara should select the external agent target from `body.model`, not from the URL path. A single
Codex model provider can point at one Caara base URL, and each Codex custom agent can choose a
different `model` string.

Recommended first model specifier shape:

```text
<external-agent-kind>/<external-model>
```

Examples:

```text
claude/opus
claude/sonnet
gemini/pro
```

Caara core parses only the first `/`. The segment before it selects the external agent kind and its
driver. The rest is an opaque external model specifier passed to the driver as-is; Caara core does
not keep a model allow-list because external harnesses may add or expose arbitrary model names.
Unknown external agent kinds or model strings without an agent-kind prefix fail explicitly.

Provider query parameters become driver options. Caara parses them generically and does not reserve
global option names or require option prefixes. The selected external agent kind scopes the option
names, so `effort` can mean different things for different drivers.

Each driver ships its own target parser and driver option schema. The driver interprets the opaque
external model specifier, validates its options, and decides which invalid values should reject a
turn and which valid changes can be applied on initial start or between turns.

Suggested selected target shape:

```ts
interface AgentTarget {
  readonly requestedModel: string;
  readonly externalAgentKind: string;
  readonly externalModelSpecifier: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
}
```

### Session Directory

Caara should persist a session binding keyed by external agent kind and Codex thread id. Codex
thread id is stable across follow-up turns for one subagent; parent session id is shared by multiple
subagents and is not a Caara session key. Requested model and driver options are mutable desired
state for that driver binding, not durable identity.

Session bindings live in Caara's user-state directory, not in the project repository. For durable
drivers, they contain external session ids and runtime state that should survive Caara restarts but
should not become source-controlled project artifacts.

The session directory stores resume metadata only. Caara does not persist transcript or event replay
state in the session directory for v1; durable external agents own their own conversation
durability. Caara may write relay logs for observability, but those logs are not a source of truth
for resuming or replaying a session.

Recommended state directory resolution:

1. Use `CAARA_STATE_DIR` when set.
2. Else use the platform user-state directory for Caara.
3. Else use `$XDG_STATE_HOME/caara`.
4. Else use `$HOME/.local/state/caara`.

Recommended session directory path:

```text
<caara-state-dir>/sessions
```

Recommended durable identity:

```ts
interface CaaraSessionKey {
  readonly externalAgentKind: string;
  readonly codexThreadId: string;
}
```

Recommended session binding shape:

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
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly externalSession: ExternalSessionState;
  readonly cwd: string;
  readonly createdFromTurnId: string;
  readonly lastTurnId: string;
}
```

For an existing binding, incoming requested model and raw driver options are compared with the
persisted binding. If they differ, Caara passes the desired target state and the previous binding
state to the driver. Drivers that support model or option changes should apply them before handling
the turn. Drivers that cannot apply a requested change should log a warning and continue with the
existing external agent session.

Drivers that do not support session durability use `ExternalSessionState._tag === "Ephemeral"`.
Caara may still keep a binding for target diffing, cwd reuse, and observability, but it must not
pretend the external agent has retained prior conversation state.

Ephemeral drivers are out of scope for the initial Claude Code driver. Future ephemeral support
requires Codex context reconstruction from Codex thread logs; Caara should not ask the managing
agent to restate context for ordinary ephemeral-driver turns.

Recommended cwd resolution:

1. Use persisted cwd for an existing Codex thread.
2. Else use the first path from `x-codex-turn-metadata.workspaces`.
3. Else use validated cwd candidates extracted from the body.
4. Else fail explicitly; external code agents need a working directory.

### Session Recovery

If a durable driver cannot resume the external session id stored in a binding, Caara should keep the
Codex turn flow alive when the driver can start a fresh external session. Caara logs a warning,
updates the binding to the fresh external session id, and returns an assistant message asking the
managing agent to provide the lost context and restate the question.

Recommended recovery message:

```text
I couldn't resume the previous external agent session, so I lost the prior context of this subagent conversation. Please send me the relevant past context and restate the question.
```

This is a normal agent reply, not a transport error. Caara should not silently continue as if the
old context was present.

If the driver can neither resume the stored external session nor start a fresh external session,
Caara fails the turn with an OpenAI-shaped transport error, logs the driver failure, and leaves the
existing binding unchanged for inspection.

### Turn Concurrency

Caara should allow at most one in-flight turn per session key. Overlapping turns for the same
`{ externalAgentKind, codexThreadId }` should not happen in normal Codex subagent behavior and
should be treated as a protocol anomaly.

For v1, Caara rejects the overlapping turn and logs a relay event with the session key, incoming
turn id, and already-running turn id. It does not queue the turn and does not drive one external
agent session concurrently.

### Turn Cancellation

If Codex disconnects the Responses SSE stream while a turn is in flight, Caara treats the disconnect
as turn cancellation. Caara asks the driver to cancel the current turn and logs the cancellation
with the session key and turn id.

Drivers own the cancellation mechanism for their external agent kind. If a driver supports
interrupting the turn without damaging the external session, it should do so. If it cannot interrupt
safely, it returns a cancellation outcome that tells Caara whether the external session is still
reusable.

Turn abandonment means Caara stops relaying to Codex while the external harness may continue
running. This is not safe cancellation by itself. If abandoned work can mutate a durable external
session in a way Codex never observes, the driver must report the session as not reusable so Caara
does not resume into hidden context.

### Driver Seam

The driver-facing module should expose one deep entrypoint for a Codex turn, not separate public
start/resume/send lifecycle operations.

Drivers declare whether they support session durability and driver residency. These capabilities are
separate:

- A durable, non-resident driver may spawn the external harness for every turn and resume with an
  external session id.
- A resident driver may keep a live harness between turns for performance.
- An ephemeral driver has no external session to resume and handles each turn without claiming prior
  external-agent context.

Residency TTL applies only to drivers that explicitly opt into driver residency. Non-resident
drivers are torn down after each turn and do not need idle reaping.

Suggested capability shape:

```ts
interface DriverCapabilities {
  readonly sessionDurability: "durable" | "ephemeral";
  readonly supportsResidency: boolean;
  readonly supportsOptionChanges: boolean;
}
```

Suggested cancellation outcome shape:

```ts
type DriverCancellationOutcome =
  | { readonly _tag: "Interrupted"; readonly sessionReusable: true }
  | { readonly _tag: "Abandoned"; readonly sessionReusable: boolean }
  | { readonly _tag: "Terminated"; readonly sessionReusable: false };
```

Recommended interface:

```ts
startOrResumeTurn({
  codex: CodexTurnContext,
  target: AgentTarget,
  previousTarget: AgentTarget | undefined,
  prompt: AgentTurnInput,
  signal: AbortSignal,
}) -> Stream<AgentRuntimeEvent>
```

The driver implementation owns process reuse and external agent session ids when available. One
driver might keep a process warm, another might respawn a CLI with a resume id, and another might
start a fresh harness every turn. Callers should not know which lifecycle policy is active.

The caller owns target selection, Codex turn context decoding, and relaying normalized agent runtime
events back onto the Responses transport.

## Codex Role Configuration

The local Codex role lives at `.codex/agents/caara.toml`. It is self-contained: the role file includes both the `caara` agent config and the `[model_providers.caara]` provider block.

The provider block is intentionally embedded in the role file because Codex validates role config layers before merging project-level provider config.

Codex custom agent files can set a Caara-interpreted model string:

```toml
name = "claude-opus"
description = "Delegates to Claude Code Opus through Caara."
developer_instructions = "Use the Caara-backed Claude Code agent."
model_provider = "caara"
model = "claude/opus"

[model_providers.caara]
name = "Caara"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
query_params = { effort = "high" }
```

`query_params` is a model-provider setting in Codex. Caara receives those parameters on the
`/v1/responses` request URL and treats them as driver options.

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
