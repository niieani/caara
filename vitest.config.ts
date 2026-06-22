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

/**
 * Runtime files with intentional service lifecycle or real-signal timing semantics.
 */
const runtimeSerialFiles = [
  "runtime/gracefulShutdownRuntime.test.ts",
  "runtime/reloadRecoveryRuntime.test.ts",
];

export default defineConfig({
  test: {
    root: path.join(import.meta.dirname, "src"),
    exclude: toolingExcludes,
    setupFiles: ["testing/parentOutputGuard.ts", "testing/vitestProcessGuard.ts"],
    // 10 second timeout is already very high; do not increase this.
    // The extra buffer is for slower machines and CI; individual tests should stay under
    // 5 seconds locally. If a test needs longer, remediate implementation or test
    // synchronization instead of increasing the timeout to make it pass.
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "non-runtime",
          exclude: [...toolingExcludes, "runtime/**/*.test.ts"],
          sequence: {
            groupOrder: 0,
          },
        },
      },
      {
        extends: true,
        test: {
          name: "runtime",
          exclude: [...toolingExcludes, ...runtimeSerialFiles],
          include: ["runtime/**/*.test.ts"],
          // Cap 4 exposed simulator control socket pressure in attachment runtime tests under
          // full-suite load. Keep cap 3 until boundary simulator control lifecycles are hardened.
          maxConcurrency: 3,
          maxWorkers: 3,
          sequence: {
            groupOrder: 1,
          },
        },
      },
      {
        extends: true,
        test: {
          name: "runtime-serial",
          include: runtimeSerialFiles,
          maxConcurrency: 1,
          maxWorkers: 1,
          sequence: {
            groupOrder: 2,
          },
        },
      },
    ],
  },
});
