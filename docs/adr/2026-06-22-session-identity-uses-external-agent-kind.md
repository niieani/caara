# Session identity uses external agent kind

Caara will key durable session bindings by external agent kind and Codex `threadId`, while storing
the requested model and driver options as mutable binding state. This lets a Claude Code session,
for example, continue across model or effort changes when the external harness supports it; drivers
that cannot apply a changed option should log a warning and keep the existing external agent
session rather than forcing Caara to hard-fail or start a different session.
