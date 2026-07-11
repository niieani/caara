# Verification

- Red: help/version/subcommand tests failed before root command tree; self-copy predicate test failed
  before installed-binary identity handling.
- `bun run test --run src/caaraCli.test.ts src/caaraSettings.test.ts src/caaraStatus.test.ts
  src/caaraDoctor.test.ts src/caaraServiceLifecycle.test.ts src/codexRoleInstaller.test.ts`
- `bun run typecheck`; `bun run lint`; `bun run fmt:check`; `git diff --check`.
- `bun install --frozen-lockfile` reapplied updated Effect patch; CLI tests stayed green.
- Compiled `dist/caara`: root help, version, and install-service help exited 0 with empty stderr;
  root help listed six subcommands with separated descriptions.
- Compiled self-reinstall reproduction: copied binary into isolated `XDG_BIN_HOME`, executed it from
  that managed path with `install-service --no-start --no-install-codex-roles --yolo`; completed and
  wrote config, service, and receipt without self-copy error.
- Zsh completions generated 149 lines, exit 0, empty stderr.
- Builder compliance/cleanup reviews completed; fixed version-test coupling and added typed handler
  dispatch/global-action coverage from findings.
