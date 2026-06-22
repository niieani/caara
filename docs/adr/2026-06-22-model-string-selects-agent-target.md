# Model string selects the agent target

Caara will use Codex's request body `model` string to select the external agent kind, rather than
using different base URL paths or Caara route config. Caara core parses only the prefix before the
first `/`; the remainder is an opaque external model specifier interpreted by the selected driver.
This lets Codex custom agent files express targets such as `claude/opus`, keeps Caara on one
`/v1/responses` transport, and avoids hardcoding external harness model catalogs in Caara core.
