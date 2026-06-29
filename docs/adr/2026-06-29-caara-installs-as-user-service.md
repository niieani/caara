# Caara installs as a user service

Caara will install as a per-user service backed by a compiled single-file executable, not as a root
system daemon or a service pointing at a cloned repository. The installed service uses one
cross-platform YAML configuration path, `${XDG_CONFIG_HOME:-$HOME/.config}/caara/config.yaml`, with
CLI arguments overriding YAML and YAML overriding built-in defaults such as host `127.0.0.1`, port
`8787`, and `allowDangerousSkipPermissions: false`.

This keeps Caara in the same user context as Codex and external agent credentials, supports both
repo-local and release-asset installation flows, and gives uninstall a clear boundary: remove the
user service and installer-managed binary by default while preserving config, state, and logs unless
purge is requested.

Caara owns its service log file and rotates it before starting app-owned runtime layers, rather than
depending on launchd or systemd stdout file redirection. This gives macOS and Linux the same
operator-facing log location and keeps service-manager units stable across logging policy changes.

Caara may bind to non-loopback hosts when the operator sets `host` or `--host`, but localhost remains
the default. Documentation must call out that exposing Caara without an additional auth layer is
dangerous on untrusted networks; the intended non-loopback use case is controlled isolation such as
Docker with bind-mounted workspaces.

Caara service configuration owns path prefixes, not a full replacement for shell `PATH`. Foreground
Caara runs prepend configured path prefixes to the inherited process `PATH`; installed service runs
set `CAARA_SERVICE=1` and append built-in defaults such as `$HOME/.local/bin`, Homebrew locations,
and system bin directories instead of inheriting transient interactive shell state. `caara doctor
--fix` may add discovered non-default executable directories for all registered driver requirements.
