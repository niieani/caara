# Caara owns installed Codex agent roles

Caara will create and update installed Codex agent roles as Caara-owned artifacts, not as
user-editable templates or raw copies of checked-in smoke roles. The role installer manages only
Caara-named role files for locally available supported drivers, marks them as generated, and reports
skipped drivers explicitly; this lets `install-service` keep global Codex role config current
without trampling unrelated user roles or turning repository smoke fixtures into the install
contract.

The explicit command is `caara install-codex-roles`. `caara install-service` runs it by default
after service configuration is written, and `install-service --no-install-codex-roles` opts out.
This applies to `install-service --no-start` too; no-start skips service startup and health checks,
but it still writes generated Codex roles unless explicitly opted out.
`caara uninstall-service` removes Caara-marked installed Codex roles while leaving unmarked custom
role files untouched.
`caara uninstall-codex-roles [target-dir]` exposes the same Caara-marked role cleanup without
touching the service.

By default, `install-codex-roles` writes to `${CODEX_HOME:-$HOME/.codex}/agents`, creating the
directory when needed. An optional target directory argument, for example
`caara install-codex-roles ./.codex/agents`, installs the same managed role set into a project-local
or test-specific role directory.

Generated files carry a Caara marker. Updates fail on unmarked same-name files; for marked files,
Caara regenerates the role while preserving existing `[model_providers.caara].query_params` keys so
users can keep driver-option customizations across generated-role updates.
When a previously generated role belongs to a driver that is no longer found, Caara removes that
stale marked role; it never deletes unmarked files.

Driver detection is contextual. When invoked by `install-service`, role generation uses the service
execution path resolved into the installed service config. When invoked as standalone
`install-codex-roles`, detection prefers the current shell `PATH` for simplicity.
