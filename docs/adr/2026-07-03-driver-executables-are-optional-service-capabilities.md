# Driver executables are optional service capabilities

Caara service installation must not fail merely because one of `claude`, `agy`, or another
external-agent driver executable is missing. Public installation should succeed when at least one
real external driver is functional, doctor output should report missing driver capabilities,
installed Codex roles should be generated only for drivers whose executables are found, and turns
targeting unavailable drivers should fail explicitly at request time.

This revises the earlier strict install behavior where `install-service` failed if any registered
driver executable requirement remained missing after doctor repair. That behavior is too brittle for
a public Homebrew install where users may intentionally install only one external agent family.
Diagnostic-only availability is not enough for a successful operator install; `doctor` and
`install-service` should exit 1 with clear user-readable errors if neither Claude nor Antigravity is
found.
