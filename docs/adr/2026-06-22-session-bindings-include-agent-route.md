---
status: superseded by ADR-2026-06-22-session-identity-uses-external-agent-kind
---

# Session bindings include the agent route

Caara will key durable session bindings by both `routeName` and Codex `threadId`, rather than by
Codex thread alone. Codex thread id is the stable subagent identity across turns, but route identity
selects the external agent and configuration; including it prevents a later Codex role/base URL
change from accidentally resuming a thread into the wrong external agent session.
