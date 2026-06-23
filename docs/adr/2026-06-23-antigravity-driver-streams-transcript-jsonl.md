# Antigravity driver streams transcript JSONL

The Antigravity CLI has no SDK, so Caara will spawn `agy` per turn and use
`transcript_full.jsonl` under Antigravity's user-state `brain/<conversationId>` directory as the
primary live event stream. The driver discovers the conversation id from the configured `--log-file`,
tails newline-complete JSONL records, validates each transcript event shape, and treats stdout only
as corroborating process output rather than the source of relayed Responses events.

This deliberately avoids parsing Antigravity's SQLite conversation database. The transcript is a
relay observation surface, not a session-durability source: the resume cursor stores only the
Antigravity conversation id, and the transcript path is derived from that id. Unknown required event
shape, missing transcript creation, malformed JSONL, process failure, or process success without a
completed model response are hard driver failures.

The driver relays only mapped Responses items from the transcript: displayable `thinking` becomes
reasoning, final model content becomes assistant output, and tool/activity records become optional
assistant commentary. Raw transcript records, the log file, and any local database content remain
diagnostic/user-state artifacts and are not emitted as API payloads.
