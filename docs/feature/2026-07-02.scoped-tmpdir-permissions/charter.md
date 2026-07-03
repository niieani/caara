# Scoped TMPDIR Claude Permissions

## Brief

Implement PRD `CAARA-okdasmed`: make the checked-in `caara-claude` role able to perform scoped
smoke writes under process `TMPDIR` without `permission_mode=bypassPermissions`.

## Goal

Claude provider query params can grant Claude Code access to the current process TMPDIR and
auto-allow edits only under `$TMPDIR/caara-panel/smoke/**`. Caara expands only `$TMPDIR` and
`${TMPDIR}` in Claude permission-related driver options. Missing, empty, or relative TMPDIR fails
explicitly. Unsupported env placeholders fail explicitly.

## Scope

In scope:

- Claude Agent SDK driver option parsing and SDK `Options` mapping.
- `allowed_tools` and `disallowed_tools` rule-specifier TMPDIR expansion.
- New `additional_directories` query option.
- Public docs and checked-in `caara-claude` role config.
- Manual Codex subagent smoke evidence.

Out of scope:

- Generic environment expansion.
- Global Caara option names.
- Dangerous permission bypass.
- Broad Bash/write permissions unless smoke proves a narrowly documented need.

## Criteria

- `additional_directories=$TMPDIR` maps to SDK `additionalDirectories` with an absolute TMPDIR path.
  Verify with focused SDK option tests.
- `allowed_tools=Edit($TMPDIR/caara-panel/smoke/**)` expands to Claude absolute rule syntax with
  doubled leading slash inside the tool specifier. Verify with focused SDK option tests.
- `${TMPDIR}` variant works in directory and rule specifier inputs. Verify with focused SDK option
  tests.
- Missing, empty, or relative TMPDIR fails explicitly. Verify with focused SDK option tests.
- Unsupported env-style placeholders in scoped options fail explicitly. Verify with focused SDK
  option tests.
- `AskUserQuestion` rejection behavior remains preserved. Verify with existing/focused permission
  tests.
- `.codex/agents/caara-claude.toml` uses the new scoped params while keeping
  `permission_mode=dontAsk`. Verify by inspection and manual smoke.
- Manual smoke creates `$TMPDIR/caara-panel/smoke/caara-claude.md` and fresh relay logs show no
  required-write `PermissionDenied`. Verify with retained evidence under this workdesk.

## Execution

Work dependency order:

1. `CAARA-jwebokyx`
2. `CAARA-muroxffy`

Each child gets red tests first, full validation before `done`, fp completion comment, and atomic
commit. Final PRD review by independent subagent before closing.
