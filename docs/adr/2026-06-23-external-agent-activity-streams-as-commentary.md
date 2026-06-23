# External-agent activity streams as commentary by default

Caara will summarize external-agent tool activity and progress as terse assistant commentary
messages by default, with a driver option to opt out when the extra transcript noise is undesirable.
Commentary should use activity phrases like "Reading src/server.ts" rather than actor-prefixed
sentences. Caara will not emit Claude or other external-agent tool events as Responses
`function_call`, custom tool, or raw item payloads, because Codex may execute some of those item
types, ignore others, and store assistant commentary in its own history.

For the Antigravity CLI driver, transcript records with `tool_calls` and completed tool-result
records such as `LIST_DIRECTORY` or `VIEW_FILE` map to this activity-commentary path. The driver
should derive concise phrases from `toolSummary`, `toolAction`, tool name, and safe path metadata;
it must not relay raw transcript JSON as assistant text or Responses tool calls.
