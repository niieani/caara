# Session bindings store opaque driver resume cursors

Caara session bindings will store a driver resume cursor as an opaque string rather than a
Caara-known provider schema. Drivers own validation and encoding of their cursor data, including
versioned JSON or other structured formats when needed, while Caara core only persists the string
and passes it back to the same external agent kind on follow-up turns.

For the Antigravity CLI driver, the resume cursor is a driver-owned versioned JSON string containing
the Antigravity conversation id. The driver resumes with `agy --conversation <conversationId>`.
Transcript paths are derived from the conversation id and are not stored in the cursor, because
transcripts are a relay observation surface rather than the continuity source of truth.
