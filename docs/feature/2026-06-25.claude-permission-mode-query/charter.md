# Claude permission mode query option

## Brief

Add Claude SDK driver provider-query support for noninteractive permission modes.

## Goal

Claude driver accepts a permission-mode query option and forwards it to SDK `permissionMode`.
Allowed values only:

- `auto`
- `dontAsk`
- `bypassPermissions`

Default remains `dontAsk`.

## Scope

In:

- Claude SDK driver option parsing.
- SDK query option construction.
- Focused regression coverage.
- Public Caara spec option list.

Out:

- Interactive permission prompting.
- Additional Claude SDK permission modes.
- Antigravity driver behavior.

## Criteria

- `permission_mode=auto` builds SDK options with `permissionMode: "auto"`.
- `permission_mode=dontAsk` builds SDK options with `permissionMode: "dontAsk"`.
- `permission_mode=bypassPermissions` builds SDK options with `permissionMode: "bypassPermissions"` and SDK bypass opt-in.
- Unsupported modes fail explicitly.
- Default with no query param remains `dontAsk`.
- Verification: targeted Vitest file(s), source review.
