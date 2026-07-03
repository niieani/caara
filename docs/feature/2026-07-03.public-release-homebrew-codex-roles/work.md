# Work notes

## Dependency order

Independent first: `CAARA-kmqgxlrr`, `CAARA-nxvfugbz`, `CAARA-sairihdp`,
`CAARA-zhirugxs`.

Then: `CAARA-lqljzggf` after metadata; `CAARA-rfwdujcr` after driver capability;
`CAARA-clbsiqct` after Antigravity mapping and safe roles; `CAARA-hvsobeav` after Antigravity role
catalog; `CAARA-xjslyvxw` after driver capability and role cleanup; `CAARA-edalefvj` after service
lifecycle roles; `CAARA-ordiuwwa` after tarballs and service lifecycle; `CAARA-modlfkpr` after
metadata, CI, tarballs, yolo, cask; `CAARA-sweqbkzp` last.

## Source observations

- Release metadata, CI, versioned tarballs, release publish workflow, cask generation, optional
  driver capability, generated installed roles, yolo posture, and docs are now implemented.
- Remaining live release risk is external: GitHub workflow dispatch, Apple signing/notary material,
  GitHub release upload, and Homebrew tap push require a real release/tag environment.

## Validation artifacts

Record child-specific commands and notable evidence in fp comments. Keep one-off logs under
`temp.local/2026-07-03/` when needed.

## Completed child commits

- `CAARA-kmqgxlrr`: `f16b2d4` release metadata + Release Please.
- `CAARA-nxvfugbz`: `2e83d22` CI gate.
- `CAARA-sairihdp`: `323bb8c` Antigravity effort model mapping.
- `CAARA-zhirugxs`: `106f960` optional real driver executable capabilities.
- `CAARA-lqljzggf`: `ba9672a` versioned public release tarballs.
- `CAARA-rfwdujcr`: `e60b332` safe generated Claude Codex roles.
- `CAARA-clbsiqct`: `1f4f958` Antigravity installed role catalog.
- `CAARA-hvsobeav`: `9c52f95` managed role update/preserve/collision/stale cleanup/uninstall.
- `CAARA-xjslyvxw`: `c06149b` service lifecycle role integration.
- `CAARA-edalefvj`: `6069357` yolo service/role permission posture.
- `CAARA-ordiuwwa`: `d87c1eb` Homebrew cask generation.
- `CAARA-modlfkpr`: `9170b15` signed release publish workflow + tap update.

## Final verification

See `verification.md`.

Local evidence for `CAARA-sweqbkzp`:

- `bun run build:service` created `dist/caara`.
- `dist/caara install-codex-roles temp.local/2026-07-03/sweqbkzp-025511/codex-agents`
  installed 9 generated roles.
- `dist/caara doctor` found real drivers:
  `/Users/bbrzoska/.local/bin/claude` and `/Users/bbrzoska/.local/bin/agy`.
