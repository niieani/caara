# Unified root CLI command

## Brief

Fix `caara --help` and `caara --version` printing their requested output followed by
`CaaraSettingsError`, list all supported subcommands in root help, and make repeated
`install-service` calls work when the executing compiled binary is already the managed destination.

## Goal and scope

One Effect CLI root command owns global action flags, root server settings, and discovery/dispatch
for `status`, `doctor`, `install-service`, `uninstall-service`, `install-codex-roles`, and
`uninstall-codex-roles`. Existing in-process command implementations remain behavior seams.

In scope: root CLI composition, typed flag/argument definitions, package version reporting,
idempotent installed-binary handling, regression tests, CLI docs. Out of scope: changing unrelated
command domain behavior, release/push, unrelated `bakeoff/` files.

## Decisions

- Replace manual first-argument dispatch; do not patch help output text manually.
- Effect CLI owns supported syntax, descriptions, help, version, completions, and log level.
- Existing domain-facing runners continue accepting argv until independently refactored; typed
  command handlers serialize parsed values into that boundary.
- Missing or invalid values fail through Effect CLI before domain execution.

## Criteria and verification

- `caara --help` exits successfully, has no error log, and lists all six subcommands: CLI help test
  and compiled-binary smoke.
- `caara --version` exits successfully and prints package version: CLI test and compiled smoke.
- `--completions` and `--log-level` are handled by Effect rather than rejected by a private allowlist:
  root command design review and focused tests where stable.
- Existing command dispatch behavior remains represented by command handler tests and existing
  focused suites.
- Re-running `install-service`, including `--yolo`, from the managed installed binary does not copy
  a file onto itself and completes remaining installation work: lifecycle regression test.
- Focused tests, typecheck, lint, format check, and compiled executable smoke pass.

## Execution shape and limits

Single TDD slice with independent compliance and cleanup reviews. Read repository and bundled Effect
v4 sources. Writes limited to workdesk, CLI composition/tests, directly affected settings parser,
and relevant CLI documentation.
