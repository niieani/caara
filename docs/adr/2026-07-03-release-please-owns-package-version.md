# Release Please owns the package version

Caara will add a `package.json` version and let Release Please maintain it alongside changelog,
tags, GitHub releases, and release notes. Release automation will still derive artifact names from
the release tag for GitHub and Homebrew compatibility, but `package.json` remains the repository's
checked-in version source instead of keeping release versions only in tags or manual edits.
The initial public release version is `1.0.0`.

NPM publishing is intentionally deferred until token handling is worth adding. Until then,
`package.json` versioning is release metadata for source, binary, and Homebrew distribution, not an
NPM publish signal, and `package.json` may remain `private: true`.
