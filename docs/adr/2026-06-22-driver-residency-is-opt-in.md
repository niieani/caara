# Driver residency is opt-in

Caara separates session durability from driver residency. A driver may be durable without keeping a
process warm, resident without Caara treating the session binding as a transcript, or ephemeral with
no external session to resume. Idle TTL applies only to drivers that explicitly opt into driver
residency; the default lifecycle is per-turn harness startup so Caara does not invent keepalive
semantics for drivers that cannot support them. Ephemeral drivers are future work and require Codex
context reconstruction from Codex thread logs rather than asking the managing agent to restate
ordinary turn context.
