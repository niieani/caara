# Caara server settings

## Brief

Add first-class Caara server settings configurable at startup. Server settings must include the HTTP
port and a global dangerous-permission gate.

## Goal

`caara` starts with `--port <integer>` and `--allow-dangerous-skip-permissions`. The dangerous flag is
a server-level allow gate only. It does not force dangerous bypass for every turn.

## Scope

In scope:

- Parse startup args for `--port` and `--allow-dangerous-skip-permissions`.
- Default port remains `8787`.
- Default dangerous gate remains `false`.
- Wire port into the mock Responses HTTP server.
- Wire dangerous gate into Claude and Antigravity driver option validation.
- Let tests inject settings without mutating process globals.
- Update README/spec docs.

Out of scope:

- Environment-variable settings.
- Config files.
- New per-request driver option names.
- Interactive permission approval flows.

## Decisions

- `--allow-dangerous-skip-permissions` allows request-level dangerous modes:
  - Claude `permission_mode=bypassPermissions`.
  - Antigravity `dangerously_skip_permissions=true`.
- Without the server flag, those request-level modes fail explicitly.
- Existing non-dangerous defaults stay unchanged.

## Criteria

- CLI parser accepts no args, `--port <n>`, `--port=<n>`, and
  `--allow-dangerous-skip-permissions`.
  Verifier: focused unit tests.
- CLI parser rejects unsupported flags, missing port values, non-integer ports, and out-of-range
  ports.
  Verifier: focused unit tests.
- HTTP server layer uses configured port.
  Verifier: focused mock provider test or construction seam test.
- Claude rejects `permission_mode=bypassPermissions` when the global gate is false and sets SDK
  `allowDangerouslySkipPermissions` when true.
  Verifier: focused Claude option tests.
- Antigravity rejects `dangerously_skip_permissions=true` when the global gate is false and builds
  `--dangerously-skip-permissions` argv when true.
  Verifier: focused Antigravity option tests.
- `bun run fmt`, focused tests, and typecheck pass.
  Verifier: command output.

## Execution

Small direct TDD change. Write red focused tests first, then implement the shared settings seam and
update docs.
