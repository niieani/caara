# Embedding text assets in the compiled binary

- Bun inlines `import x from "./file.md" with { type: "text" }` as a string at bundle/compile
  time — this is how repo files (e.g. the panel skill) ship inside `dist/caara`. Verified via
  `bun run build:service` + running the binary against a temp `CODEX_HOME`.
- vitest's vite pipeline cannot parse raw `.md` imports (it ignores the import attribute and
  tries to load the file as JS). `vitest.config.ts` registers `caara:markdown-as-text`, a tiny
  transform plugin serving `.md` as `export default "<content>"`. Any new embedded asset type
  needs the same treatment.
- TS support comes from `src/markdownModules.d.ts` (`declare module "*.md"`).
- Keep embedded records in sync with their source directory via a sync test
  (see `src/panelSkillAssets.test.ts`): compares `readdir(recursive)` of the source tree against
  the embedded record keys and contents, so a new skill file fails CI until the import is added.
