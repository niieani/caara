# Displayable external-agent reasoning uses Codex reasoning items

When an external-agent SDK exposes reasoning or thinking content that is explicitly displayable,
Caara will map it to Codex reasoning stream items rather than assistant commentary. Raw or private
thinking content must not be surfaced as assistant text; it should stay out of Responses output
unless the driver can classify it as displayable reasoning summary.

For the Antigravity CLI driver, the `thinking` string in `transcript_full.jsonl` is treated as
displayable reasoning by default and mapped to Codex reasoning items. The driver may provide an
opt-out option, but must not silently discard this field. If Antigravity changes the field shape or
the driver can no longer classify it as displayable, the driver should fail closed instead of
relaying unknown reasoning content.
