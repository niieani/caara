# Installed Codex roles include driver variants

Caara's installed Codex role generator will create multiple Caara-owned roles for each locally
available supported driver rather than only one production-default role. Repository smoke roles stay
separate from installed roles, but the installed global role surface should expose useful driver
variants such as multiple Claude model aliases and Antigravity model choices when the corresponding
driver executable is available.

Availability checks stop at executable discovery. Caara will not probe remote model or account
availability while generating roles; driver-owned static presets may include variants that fail
explicitly on first use if the user's external-agent account cannot access that model.

Claude installed roles use explicit variant names instead of a generic `caara-claude` default:
`caara-claude-haiku`, `caara-claude-sonnet`, `caara-claude-opus`, and `caara-claude-fable`.

Antigravity installed roles use short `caara-agy-*` names and do not create separate roles for
Low, Medium, or High variants. Initial base roles are `caara-agy-gemini-3-5-flash`,
`caara-agy-gemini-3-1-pro`, `caara-agy-claude-sonnet-4-6`,
`caara-agy-claude-opus-4-6`, and `caara-agy-gpt-oss-120b`; effort-specific Antigravity display
names are selected by the driver at turn time. These roles use slug model specifiers such as
`agy/gemini-3.5-flash` rather than exact `agy --model` display strings.
