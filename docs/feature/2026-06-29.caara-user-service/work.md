# Caara User Service Work

## Dependency Order

1. `CAARA-ckwgmhnm` build artifacts.
2. `CAARA-kgkuzxvh` strict config and root CLI.
3. `CAARA-qqewuapw` execution path semantics.
4. `CAARA-tkrpstwk` health/status.
5. `CAARA-dibwdpur` rotating app logs.
6. `CAARA-meuxlgcy` driver requirements/doctor.
7. `CAARA-vxcgptzv` no-start install/uninstall.
8. `CAARA-ttejblzo` service start/doctor/health verification.
9. `CAARA-thtxxrcv` docs.

## Design Notes

- Keep pure/domain seams separate from Bun/process/service-manager IO so tests avoid real launchd,
  systemd, codesign, and cross-compilation.
- Use `Bun.YAML.parse` then Effect Schema validation; reject multi-doc arrays explicitly.
- Use `Bun.YAML.stringify(value, null, 2)` for block-style config writes.
- Keep config `path` as user prefixes only; defaults are computed, not persisted.
- Treat missing explicit `--config` as an error and missing default config as defaults.
- Service install from source fails; compiled binary detection must be explicit.
- Runtime logging layer should preserve foreground console output while adding app file logging.

## Validation

- Focused tests per slice first.
- Full `bun run lint`, `bun run test --run`, `bun run fmt` before each issue closure.
- Subagent PRD review after all children.
