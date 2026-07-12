# ADR 0014: Portable session identity is explicit

## Status

Accepted

## Context

Portable Agent callers need both fresh independent delegation and explicit continuation without
depending on a driver's session identifier format. A timed wait must not own or cancel execution,
and concurrent turns must not mutate one hidden conversation.

## Decision

- Caara issues the portable `sessionId`; omission creates a new identity.
- Supplying `sessionId` is a resume request. The service requires its durable session binding and
  fails explicitly when the binding is unavailable; it never substitutes a fresh driver session.
- The transport-neutral AgentTurn identity carries the portable session ID. Existing session
  binding and turn-concurrency modules therefore remain the only resume and single-flight
  authorities.
- Driver resume cursors remain opaque inside session bindings and never cross HTTP or CLI schemas.
- `wait` accepts a bounded timeout. Timeout returns the latest coarse `working` projection and
  leaves the registered execution, session binding, cancellation handle, and durable turn record
  untouched. Later waits may retrieve the terminal projection.
- One active turn per portable session. Independent omitted-session starts remain concurrent.

## Consequences

Portable adapters share the same durable resume and conflict behavior as Responses without
learning driver cursor formats. A missing binding is a hard recovery boundary. Agent-facing wait
responses remain blind: coarse state, terminal failure, or final answer only.
