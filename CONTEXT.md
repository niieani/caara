# Caara

Caara makes Codex subagents able to run through external code-agent runtimes while Codex still
speaks the Responses-compatible subagent transport it already supports.

## Language

**Caara**:
The bridge that lets Codex delegate subagent work to external code agents.
_Avoid_: Provider, mock provider, simulator

**Managing agent**:
The parent Codex session that creates and talks to subagents.
_Avoid_: Parent process, caller

**Codex subagent**:
A Codex-managed delegated agent handle with its own stable Codex thread identity.
_Avoid_: Fake subagent, simulated subagent

**External agent**:
A non-Codex code agent that Caara drives on behalf of a Codex subagent.
_Avoid_: Backend, provider

**Agent bridge**:
The role Caara plays between Codex and an external agent: receive Codex turns, drive an external
agent, and relay output back to Codex.
_Avoid_: Responses provider

**Agent model specifier**:
The Codex `model` string whose prefix selects the external agent kind and whose remainder is opaque
to Caara core.
_Avoid_: Route name, endpoint path, URL alias

**External model specifier**:
The opaque model string passed to a driver after Caara core extracts the external agent kind.
_Avoid_: Caara model enum, known model list

**External agent kind**:
The stable external harness family selected by an agent model specifier, such as Claude Code or
Gemini.
_Avoid_: Requested model, route name

**Driver options**:
The external-agent-specific options Caara receives from provider query parameters and gives to the
selected driver.
_Avoid_: Global config, route config, raw query params

**Driver option schema**:
The option schema owned by a driver for one external agent kind.
_Avoid_: Caara option schema, shared effort scale, prefixed options

**Agent target**:
The desired destination state for a Codex turn, resolved from an agent model specifier and driver
options.
_Avoid_: Agent route, backend config

**Driver**:
The adapter role for one external agent family, such as Claude Code or an ACP-speaking agent.
_Avoid_: Backend, provider, client

**Diagnostic driver**:
A first-class Caara driver that emits predefined runtime events for smoke-testing Caara behavior
without depending on an external agent harness.
_Avoid_: Fake driver, simulation driver, mock provider

**Session durability**:
An external agent capability to preserve conversation state across Caara turns through an agent
session or equivalent resume handle.
_Avoid_: Driver residency, idle TTL, persistence

**Driver residency**:
A driver capability to keep a live external harness available between turns for the same Caara
session key.
_Avoid_: Session durability, persistence, resume support

**Driver option change support**:
A driver capability to apply changed driver options between turns for an existing session binding,
either in place or by recycling the external harness while preserving resumable conversation state.
_Avoid_: Session reset, route change

**External harness recycling**:
Replacing a live external harness for an existing session binding while preserving the driver
resume cursor and external-agent conversation continuity.
_Avoid_: Fresh session, new Codex thread, session reset

**Residency TTL**:
The optional idle timeout after which Caara may dispose a resident driver handle without deleting
the session binding.
_Avoid_: Session expiry, binding deletion

**Codex context reconstruction**:
The future process of building prior subagent context from Codex thread logs so a non-durable
external agent can receive enough context for the next turn.
_Avoid_: Asking the managing agent for context, relay log replay

**Turn abandonment**:
A cancellation outcome where Caara stops relaying a turn while the external harness may continue
running outside the Codex response stream.
_Avoid_: Safe cancellation, detach

**Codex thread**:
The stable Codex identity for one subagent across turns.
_Avoid_: Session when referring to the Codex subagent key

**Codex turn**:
One request from Codex to Caara within a Codex thread.
_Avoid_: Message, invocation

**Agent session**:
The conversation identity owned by an external agent when that agent supports session durability.
_Avoid_: Codex thread, Codex session

**Session recovery prompt**:
An agent reply asking the managing agent to restate lost context after Caara cannot resume or
preserve continuity for an external agent session.
_Avoid_: Fatal resume error, silent reset

**Unrecoverable session start failure**:
A driver failure where Caara can neither resume or preserve the stored external agent session nor
start a fresh one.
_Avoid_: Lost context, recovery prompt

**Session binding**:
The association between one external agent kind, one Codex thread, and the driver state Caara keeps
for that pair. Requested model and driver options are mutable binding state.
_Avoid_: Session map entry, cache entry, thread-only mapping

**Driver resume cursor**:
An opaque string owned by a driver that lets it resume an external agent session for a later Codex
turn. Caara persists it but does not interpret its internal structure.
_Avoid_: External session id, Claude session schema, resume metadata object

**Caara session key**:
The durable identity for a session binding, composed from the external agent kind and Codex thread.
_Avoid_: Requested model, driver options, parent session id

**Caara state directory**:
The user-local durable storage area where Caara keeps runtime state.
_Avoid_: Project repo, workspace directory, temp directory

**Session directory**:
The durable collection of session bindings Caara uses to resume external agent sessions when the
selected driver supports session durability.
_Avoid_: Session cache, registry, transcript store

**Relay log**:
An observability record of Codex turns, driver activity, and relayed events.
_Avoid_: Transcript, replay log, source of truth

**Transcript observation surface**:
A driver-owned local stream or file Caara reads to observe external-agent activity during a turn
relay, without treating it as Caara's replay log or session-durability source.
_Avoid_: Relay log, session directory, resume cursor

**Turn relay**:
The act of translating one Codex turn into external-agent activity and streaming the resulting
events back to Codex.
_Avoid_: Completion, generation

**Turn concurrency conflict**:
An unexpected overlapping Codex turn for a session binding that already has an in-flight turn.
_Avoid_: Queue item, parallel turn

**Turn cancellation**:
A request to stop processing an in-flight Codex turn, usually caused by the managing Codex client
disconnecting from the response stream.
_Avoid_: Session close, session deletion

**Codex turn context**:
The validated Codex identity and workspace context extracted from a Codex turn.
_Avoid_: Raw headers, request metadata

**Agent turn input**:
The normalized prompt and context Caara gives to a driver for one turn.
_Avoid_: Responses input, raw prompt

**Path-based file reference**:
A driver input reference to a file that is already addressable from the external agent's workspace,
rather than an opaque uploaded file id that Caara must fetch or decode.
_Avoid_: File upload, file attachment blob, OpenAI file id

**Agent runtime event**:
A normalized event emitted by a driver while processing a turn.
_Avoid_: Provider event, SDK message

**Agent activity commentary**:
Human-readable assistant commentary that Caara streams to Codex to summarize external-agent
activity, such as tool use or progress, without exposing the underlying runtime payload as a Codex
tool call.
_Avoid_: Structured tool event, raw tool payload, function call

**Displayable reasoning**:
External-agent thinking content that a driver has classified as intended for Codex-visible reasoning
output rather than private model scratchpad or assistant text.
_Avoid_: Raw thinking, hidden chain of thought, activity commentary

**Driver permission posture**:
The driver-specific setting bundle that controls what an external agent is allowed to attempt
without asking. Caara forwards it as driver options rather than defining one global permission mode.
_Avoid_: Caara permission mode, global safety tier

**Permission prompt**:
A runtime approval request from an external agent or harness to perform an action during a turn
relay.
_Avoid_: AskUserQuestion, driver permission posture

**Agent question prompt**:
A runtime request from an external agent for managing-agent input during a turn relay.
_Avoid_: Permission prompt, follow-up task, recovery prompt

**Responses transport**:
The Codex-facing OpenAI Responses-compatible HTTP and SSE shape Caara speaks.
_Avoid_: Caara API, provider API
