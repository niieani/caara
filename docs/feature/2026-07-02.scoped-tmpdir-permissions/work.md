# Work

## Design

Keep TMPDIR handling inside the Claude SDK driver because provider query params are driver-owned.
Add a narrow expansion helper used only by:

- `additional_directories`
- `allowed_tools`
- `disallowed_tools`

Expansion rules:

- Replace `$TMPDIR` and `${TMPDIR}` with the current process `TMPDIR`.
- Validate TMPDIR exists, is non-empty, and is absolute before replacement.
- Reject unsupported env-like placeholders in scoped options, e.g. `$HOME`, `${HOME}`,
  `$TMPDIR_SUFFIX`, `$UNSET`.
- Do not expand or validate unrelated driver options.
- For Claude permission rule specifiers, convert absolute paths inside `Tool(...)` to Claude's
  double-slash syntax by replacing a leading `/` after `(` with `//`.

## Validation

Focused first slice:

- `bun run test --run src/claudeAgentSdkDriver/claudeAgentSdkPermissionPolicy.test.ts`
- `bun run test --run src/claudeAgentSdkDriver/claudeAgentSdkDriver.test.ts`

Slice completion:

- `bun lint`
- `bun run test --run`
- `bun run fmt`

Manual smoke second slice:

- Start provider with retained log in `temp.local/$(date +%F)/...`.
- Spawn `caara-claude` subagent.
- Prompt requests creation of empty `$TMPDIR/caara-panel/smoke/caara-claude.md`.
- Record file evidence and relay-log permission outcome in `smoke-evidence.md`.
