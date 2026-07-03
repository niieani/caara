# Homebrew cask installs the Caara user service

Caara's Homebrew cask will install the binary and activate Caara by delegating to
`caara install-service` from cask postflight; cask uninstall will delegate to
`caara uninstall-service` while preserving user config, state, sessions, and logs unless a separate
zap/purge path is requested. The cask must not duplicate launchd or systemd service definitions,
because the CLI already owns service files, receipts, role installation, doctor repair, startup, and
health verification.

The cask should support Homebrew zap semantics for a full purge, mapping zap cleanup to Caara's
config, state, session, and log removal policy rather than making normal uninstall destructive.
