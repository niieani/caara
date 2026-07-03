# Public releases require CI gates

Before public releases, Caara will add CI for pull requests and main that runs formatting checks,
lint, typecheck, tests, and a service build smoke. Release publishing should not be the first place
basic validation runs; Release Please and release-publish automation will sit behind the same
quality gate used for ordinary changes.
