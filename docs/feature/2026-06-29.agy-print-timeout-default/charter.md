# Antigravity Print Timeout Default

## Brief

Set Caara-owned Antigravity print timeout behavior: default `print_timeout_seconds` is 7200
seconds, explicit passthrough accepts 1 through 86400 seconds.

## Scope

In scope:

- Antigravity option parser default and bound.
- Focused parser/argv and fake-`agy` driver tests.
- README and permanent spec docs.

Out of scope:

- Other Antigravity timeout/cancellation behavior.
- External `agy` behavior changes.

## Criteria

- Missing `print_timeout_seconds` produces `--print-timeout 7200s`; verified by focused tests.
- Explicit `print_timeout_seconds=86400` is valid; `86401` fails before spawning `agy`; verified by
  focused tests.
- README/spec document the 2h default and 24h maximum.

## Verification

- `bun run test src/antigravityCliDriver/options.test.ts --run`
- `bun run test src/antigravityCliDriver/antigravityCliDriver.test.ts --run`
