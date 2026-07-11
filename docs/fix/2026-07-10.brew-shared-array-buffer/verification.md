# Verification

- Red phase: focused tests failed on absent plist, absent `--entitlements`, and absent signed-binary startup smoke.
- `bun run test --run src/releasePublishWorkflow.test.ts src/serviceBuild.test.ts`
- `plutil -lint config/caara.entitlements.plist`
- `bun run typecheck`
- `bun run lint` (green; pre-existing informational diagnostics)
- Targeted `oxfmt --check`; repository-wide check blocked by unrelated `CHANGELOG.md` formatting.
- Local macOS smoke: current-host binary copied under `temp.local/2026-07-10/`, ad-hoc signed with
  hardened runtime plus canonical entitlements, verified via `codesign`, entitlements inspected, then
  `caara status` launched successfully without the reported `SharedArrayBuffer` failure.
- Independent compliance and cleanup reviews completed; complete entitlement assertions and release
  startup smoke added from findings.
