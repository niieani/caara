# Caara User Service

## Brief

Implement fp PRD `CAARA-rkoussto`: install Caara as a per-user macOS/Linux service backed by a
compiled Bun executable, strict YAML config, health/status, rotating JSONL logs, doctor repair,
service lifecycle commands, and operator docs.

## Goal

`caara` remains the server root command, now configured by CLI-over-YAML-over-default settings.
`caara install-service`, `uninstall-service`, `status`, and `doctor` provide durable local
infrastructure without sudo. Service install copies a compiled binary to user-local bin, writes a
strict config and service unit, repairs driver executable path prefixes, starts when requested, and
verifies shallow `/health`.

## Scope

In scope:

- Bun compile build scripts and checksum/codesign command construction.
- Strict YAML service config and Effect CLI parsing for root/subcommands.
- Foreground vs `CAARA_SERVICE=1` path resolution.
- Shallow `/health` endpoint and `status` command.
- App-owned JSONL file logging with pre-start rotation.
- Driver-owned executable requirements and `doctor --fix`.
- No-start and start service lifecycle seams for launchd/systemd user services.
- README/public docs/smoke docs updates.

Out of scope:

- Root/system service mode, sudo, Windows service support.
- Auth for non-loopback exposure.
- Homebrew cask, bootstrap script, or GitHub Actions release automation.
- Continuous log rotation after process start.

## Criteria

- Each child issue in `fp tree CAARA-rkoussto` reaches `done`, with completion comment and commit.
  Verifier: `fp tree CAARA-rkoussto`, `git log`.
- All child acceptance criteria implemented without service-manager side effects in tests.
  Verifier: focused tests plus PRD review subagent.
- Slice completion rules pass before each child closes: `bun run lint`, `bun run test --run`,
  `bun run fmt`.
  Verifier: command output recorded in fp comments.
- Final integration remains green.
  Verifier: `bun run lint`, `bun run test --run`, `bun run fmt`, final PRD review.

## Execution

Sliced fp execution in dependency order. Existing uncommitted server-setting work is treated as
in-progress PRD material and folded into the relevant child commits only when acceptance criteria are
met. Workdesk: `docs/feature/2026-06-29.caara-user-service/`.
