# Unknown external-agent observations are non-fatal

External-agent runtime and activity streams are observation surfaces, not Caara's authoritative
transport contract. Well-formed but unrecognized observations from those streams are non-fatal by
default: drivers ignore them, keep observing the turn, and emit only payload-safe telemetry.

This ADR supersedes the Antigravity transcript ADR wording in
`docs/adr/2026-06-23-antigravity-driver-streams-transcript-jsonl.md` that treated every unknown
required event shape as a hard driver failure. Unknown Antigravity transcript rows, Claude SDK
messages, stream events, content blocks, and similar provider activity payloads can represent
upstream progress states that are not needed to relay a valid final answer.

This does not make malformed or authoritative data optional. Caara still fails explicitly for:

- malformed JSONL, malformed SDK payloads, or schema-invalid known shapes;
- append-only transcript violations, rewrites, or truncation;
- invalid Codex request input or unsupported current-turn content;
- unsupported driver options or invalid option values;
- external process failures and terminal SDK result failures;
- missing final output when no existing diagnostic path can explain a successful turn.

Telemetry for ignored observations must be structured and payload-safe. A warning or relay log entry
may include provider, normalized observation shape, count, step/index when present, thread and turn
correlation when present, and payload length/hash. It must not include raw unknown payload JSON,
raw tool/task ids, local transcript or brain paths, command output, task log paths, file content, or
other provider-private data.

Responses-visible assistant text remains derived only from mapped final answers, displayable
reasoning, and safe activity commentary. Unknown observation payloads must never be relayed as
assistant text, raw Responses items, tool payloads, or function-call-like output.
