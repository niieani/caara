# Agent turn input mapping is explicit

Caara will map only the current Codex turn into driver input; prior assistant output, tool output,
and other history are not replayed because external-agent continuity comes from the driver resume
cursor. User text, supported images, and path-based file references are intended driver inputs, but
each driver must validate and map them through its own SDK shape. Unsupported current-turn content
fails explicitly rather than being silently dropped; opaque uploaded file ids are not treated as
path-based file references unless Caara has a deliberate fetch/decode path for them.
