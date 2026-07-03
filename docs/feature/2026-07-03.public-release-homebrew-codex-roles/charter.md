# Public release, Homebrew, and installed roles charter

## Brief

Implement fp PRD `CAARA-aicscdae` and every child issue beneath it. fp issue text is source of
truth. Existing planning ADR/glossary changes are preserved and worked with.

## Goal

Caara can be publicly released as versioned binary tarballs, installed through a Homebrew cask, and
keeps Caara-owned installed Codex agent roles synchronized with available real external drivers.

## Scope

In scope: release metadata, CI/release workflows, versioned tarball and cask generation, optional
real driver capability checks, Antigravity effort mapping, generated installed Codex roles, service
lifecycle role integration, yolo permission posture, docs, and validation evidence.

Out of scope: npm publishing, Windows, Intel macOS public artifacts, pkg/dmg packaging, repository
visibility changes, full Antigravity model catalog, migration of unmarked hand-copied roles.

## Constraints

- Work child issues in fp dependency order.
- TDD per child: red focused tests, implementation, focused validation, full test suite, lint, fmt.
- Atomic semantic commit per completed child; commit message mentions issue id.
- Use hard failures for missing non-optional metadata/config and unsafe yolo mismatch.
- Installed roles are generated Caara-owned artifacts, not copied smoke roles.
- Public macOS artifact is Apple Silicon only.

## Verification

- Per child: focused tests, `bun lint`, `bun run test --run`, `bun run fmt`.
- PRD close: independent implementation review subagent; resolve blocking findings.
- Final docs/evidence record local build/role-generation verification and release automation limits.
