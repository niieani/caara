# Homebrew macOS startup fix

## Brief

Caara 1.2.0 installed through Homebrew fails before `install-service` with
`ReferenceError: SharedArrayBuffer is not defined` in the Bun-compiled executable.

## Goal and scope

macOS release binaries retain Bun JavaScriptCore JIT/shared-memory capabilities after hardened
runtime signing. Change release-signing inputs, workflow, build-plan contract, tests, and concise
release documentation. No application runtime fallback, migration, Homebrew tap mutation, release,
commit, or unrelated changes.

## Principles and decisions

- Fix signing root cause; do not polyfill `SharedArrayBuffer`.
- Version one canonical entitlement file based on bundled Bun 1.3.14 documentation.
- Every repository-owned macOS codesign path must consume that file.
- Fail explicitly through `codesign` when entitlement input is absent or invalid.

## Criteria and verification

- Entitlement plist enables Bun-documented JIT/runtime permissions: plist inspection and workflow test.
- GitHub release codesign passes the entitlement plist before notarization: workflow test.
- build-service codesign plan uses the same plist: service-build unit test.
- Focused tests, typecheck, lint, format check pass.
- Locally signed compiled binary exposes `SharedArrayBuffer` when macOS signing is available: manual smoke; otherwise CI/release validation remains required.

## Execution shape and limits

Single TDD slice. Read repository and bundled dependency docs. Writes limited to workdesk, signing
asset, release workflow/build contract/tests, and directly relevant permanent docs.
