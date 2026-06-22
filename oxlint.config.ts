import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
    typeCheck: true,
    reportUnusedDisableDirectives: "error",
  },
  rules: {
    "typescript/no-deprecated": "error",
  },
  settings: {
    vitest: {
      typecheck: true,
    },
  },
  ignorePatterns: [
    ".agents/",
    ".claude/",
    ".patterns/",
    ".vscode/",
    "build/",
    "coverage/",
    "data/",
    "dist/",
    "docs/",
    "node_modules/",
    "**/_generated/**",
    "references/",
    "src/**/__experiments__/**",
    "temp.local/",
  ],
});
