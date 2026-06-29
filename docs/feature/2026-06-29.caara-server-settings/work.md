# Caara server settings design

## Shape

`src/caaraSettings.ts` owns process-wide settings:

- `port`
- `allowDangerousSkipPermissions`

The startup parser accepts:

- `--port <value>`
- `--port=<value>`
- `--allow-dangerous-skip-permissions`

Invalid args fail with `CaaraSettingsError`.

## Wiring

`src/caara.ts` builds `mainLayer` from startup args and uses `CaaraSettings.port` to construct the
Bun HTTP server layer. The module only launches when `import.meta.main`, so tests can import the
construction helpers.

Claude and Antigravity drivers receive `CaaraSettings` through their registry/factory seams:

- Claude `permission_mode=bypassPermissions` requires `allowDangerousSkipPermissions`.
- Antigravity `dangerously_skip_permissions=true` requires `allowDangerousSkipPermissions`.

The setting is an allow gate only. It does not force dangerous behavior without the per-request
driver option.
