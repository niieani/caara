# Agent Turn is the transport-neutral lifecycle seam

Responses, CLI, MCP, and future adapters decode their transport contracts into one `AgentTurnContext`:
portable session identity, optional requested working directory, origin metadata, and normalized
advisories. Raw Responses requests, Codex headers, and Codex-only identity fields do not cross this
boundary. Responses owns its Codex-to-Agent-Turn adapter; drivers, session storage, and concurrency
consume only the neutral context.

`runAgentTurn` exclusively owns first/resumed driver startup, the one-turn-per-session lease, runtime
event consumption, durable completion, and cancellation. It returns the normalized runtime stream
plus an explicit cancellation effect. Stream interruption uses that same cancellation operation, so
disconnect and explicit adapter cancellation cannot create parallel lifecycle paths. Cancellation
persists a reusable session and deletes a non-reusable session before releasing the lease.

Transport adapters own event encoding and protocol errors. They may observe runtime events while
consuming the returned stream, but must not independently complete bindings, release leases, or call
driver cancellation.
