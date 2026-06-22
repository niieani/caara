import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Excludes tool-owned metadata and scratch directories from repository-level test discovery.
 */
const toolingExcludes = [
  ".agents/",
  ".claude/",
  "AGENTS.md",
  "references/",
  "temp.local/",
  "**/src/__experiments__/**",
  "node_modules/",
  "**/node_modules/**",
  "**/*.local/**",
  "**/dist/**",
];

export default defineConfig({
  test: {
    root: path.join(import.meta.dirname, "src"),
    exclude: toolingExcludes,
    // 5 second timeout is already very high; do not increase this.
    // The extra buffer is for slower machines and CI; individual tests should stay under
    // 2 seconds locally. If a test needs longer, remediate implementation or test
    // synchronization instead of increasing the timeout to make it pass.
    testTimeout: 5_000,
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          exclude: [...toolingExcludes],
        },
      },
    ],
  },
});
