# Unresumable sessions recover through dialogue

When Caara cannot resume a durable external agent session, it will log a warning, start a fresh
external session when possible, update the binding, and send an assistant reply asking the managing
Codex agent to provide the lost context and restate the question. This preserves the subagent flow
without hiding context loss or turning recoverable external session loss into a transport-level
failure. The recovery prompt is the final answer for that Codex turn, not agent activity commentary.
Caara core owns the standard recovery text: "I lost the external agent session context. Remind me,
what did we discuss prior to this message, restate any relevant context and your request." Drivers
provide a reason label and diagnostics for logs, not custom user-facing recovery prose.
If the driver cannot start a fresh session either, Caara will return an OpenAI-shaped transport
error, log the failure, and leave the existing binding unchanged for inspection.
