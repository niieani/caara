# Release assets are versioned tarballs

Caara releases will publish per-platform versioned tarballs such as
`caara_<version>_darwin_arm64.tar.gz`, each containing the `caara` executable plus release metadata
such as README and LICENSE. This replaces raw executable release assets for public publishing,
because Homebrew casks consume archives cleanly, checksums remain stable per asset, and the release
contract can match the referenced imagegen automation while preserving Caara-specific platform
names.

The macOS tarball contains a signed and notarized bare `caara` CLI executable, matching imagegen's
workflow shape. Caara will not introduce a `.pkg` or `.dmg` packaging layer for the initial public
release.

Initial public assets include `darwin_arm64`, `linux_amd64`, and `linux_arm64`. Intel macOS is not
part of the public release contract.
