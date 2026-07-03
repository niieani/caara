# Release Publish Live Run Fix

## Brief

Drive Caara's Release Please flow through a real GitHub release and Homebrew publish run. Fix release-infra gaps discovered only in live Actions:

- Release Please-created releases do not trigger `release` workflows when created with `GITHUB_TOKEN`.
- Release publish workflow used placeholder `op://caara/...` paths; the service account vault is `Automation`.
- Release Please-generated `CHANGELOG.md` needs formatting on main.

## Criteria

- Publish workflow can resolve tags from manual dispatch, release events, and successful Release Please workflow completions.
- Publish workflow skips successful Release Please runs that did not create a release.
- Workflow loads Apple signing/notary and Homebrew tap credentials from the known `Automation` vault paths.
- CI formatting passes after Release Please changelog generation.
- Live publish run for the minted release reaches signing/notarization and tap update, or reports the next exact external credential blocker.

## Verification

- `bun run test --run src/releasePublishWorkflow.test.ts`
- `bun run fmt:check`
- GitHub Actions run logs for CI and publish workflow.
- GitHub release assets, Homebrew tap cask contents, and macOS notarization evidence from logs.
