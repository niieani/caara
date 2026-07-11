# Signing design

Cause: `.github/workflows/release-publish.yml` uses `codesign --options runtime` without Bun's JIT
entitlements. Hardened runtime strips JavaScriptCore capabilities; bundled startup code observes no
`SharedArrayBuffer`.

Design: add `config/caara.entitlements.plist` with Bun 1.3.14 standalone-executable permissions.
Pass it through both release workflow and optional `build:service:all --codesign-identity` plan.
Regression tests assert semantic entitlement keys and both signing command contracts.

Source: `node_modules/bun-types/docs/bundler/executables.mdx`, “Code signing on macOS”.
