# Public macOS release is Apple Silicon only

Caara's public Homebrew cask and notarized macOS release asset will support Apple Silicon only,
matching the referenced imagegen cask. The existing `darwin-x64` build target is not part of the
public release contract unless a future decision reintroduces Intel macOS support; this keeps
signing, notarization, cask dispatch, and end-to-end smoke coverage focused on the current primary
macOS platform.
