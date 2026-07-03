import fs from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

/** Reads one workflow file from the repository root for static CI checks. */
const readWorkflow = ({ filePath }: { readonly filePath: string }): string =>
  fs.readFileSync(path.join(process.cwd(), filePath), "utf8");

/** Required CI commands that form the public-release quality gate. */
const requiredValidationCommands = [
  "bun install --frozen-lockfile",
  "bun run fmt:check",
  "bun lint",
  "bun run typecheck",
  "bun run test --run",
  "bun run build:service",
] as const;

describe("public CI workflow", () => {
  it("runs on pull requests and pushes to main", () => {
    const workflow = readWorkflow({ filePath: ".github/workflows/ci.yml" });

    assert.match(workflow, /^on:\n(?:.|\n)*pull_request:/mu);
    assert.match(workflow, /^on:\n(?:.|\n)*push:/mu);
    assert.match(workflow, /branches:\n\s+- main/u);
  });

  it("uses Bun validation commands and avoids npm or Bun's built-in test runner", () => {
    const workflow = readWorkflow({ filePath: ".github/workflows/ci.yml" });

    for (const command of requiredValidationCommands) {
      assert.match(workflow, new RegExp(`run: ${command.replaceAll(" ", "\\s+")}`, "u"));
    }
    assert.match(workflow, /uses: oven-sh\/setup-bun@v2/u);
    assert.strictEqual(/\bnpm\b|\bbun test\b/u.test(workflow), false);
  });

  it("fails hard by keeping required validation steps unconditional", () => {
    const workflow = readWorkflow({ filePath: ".github/workflows/ci.yml" });

    assert.strictEqual(/\bcontinue-on-error:\s*true\b/u.test(workflow), false);
    assert.strictEqual(/\bif:\s*\$\{\{\s*false\s*\}\}/u.test(workflow), false);
    assert.strictEqual(/\|\|\s*true/u.test(workflow), false);
  });
});
