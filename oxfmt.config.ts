import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    ".agents/",
    ".claude/",
    ".patterns/",
    ".vscode/",
    "AGENTS.md",
    "build/",
    "coverage/",
    "data/",
    "dist/",
    "docs/",
    "node_modules/",
    "references/",
    "site/",
    "src/**/__experiments__/**",
    "temp.local/",
  ],
  sortImports: true,
});
