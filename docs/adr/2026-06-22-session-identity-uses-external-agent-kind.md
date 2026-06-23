# Session identity uses external agent kind

Caara will key durable session bindings by external agent kind and Codex `threadId`, while storing
the requested model and driver options as mutable binding state. This lets a Claude Code session,
for example, continue across model or effort changes when the external harness supports it. Option
changes update the existing session binding rather than creating a different binding; drivers may
apply the change in place or recycle the external harness while resuming the same external-agent
conversation. When the selected driver cannot preserve continuity for a required option change,
Caara should start a fresh external session when possible, update the existing binding, and send a
session recovery prompt as the final answer for that turn. Caara should fail explicitly only when it
cannot start the fresh recovery session.
