# Session directory stores resume metadata only

Caara will persist binding metadata and external session ids when a driver supports session
durability, not a transcript or event log for replay. Durable external agents own conversation
durability, while Caara relay logs are observability data rather than the source of truth for
resuming a session.
