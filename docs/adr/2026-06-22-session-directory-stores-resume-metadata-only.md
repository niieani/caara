# Session directory stores resume metadata only

Caara will persist external session ids and binding metadata, not a transcript or event log for
replay. External agents own conversation durability, while Caara relay logs are observability data
rather than the source of truth for resuming a session.
