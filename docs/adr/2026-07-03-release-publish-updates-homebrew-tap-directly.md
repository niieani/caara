# Release publish updates Homebrew tap directly

Caara's release publish workflow will update `niieani/homebrew-tap` directly after release assets are
built and uploaded, matching the referenced imagegen workflow. The workflow loads the Homebrew tap
token from 1Password, rewrites `Casks/caara.rb`, commits the cask update when it changed, and pushes
without opening a review PR.
