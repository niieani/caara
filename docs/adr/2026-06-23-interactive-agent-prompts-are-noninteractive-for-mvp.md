# Interactive external-agent prompts are non-interactive for MVP

Caara will not open an approval or user-input loop with the managing agent during a Codex turn for
the MVP. Driver permission posture remains driver-owned and is passed through as driver options, but
any permission prompt that reaches Caara is auto-denied. Drivers should suppress agent question
prompts when possible, such as disallowing Claude Code's `AskUserQuestion` tool, because supporting
them would require a resident parked-turn state that is not needed for the first SDK-backed driver.
For Claude Code, `AskUserQuestion` is reserved and disallowed by default; driver option validation
must fail explicitly if user-supplied tool settings attempt to allow it.
