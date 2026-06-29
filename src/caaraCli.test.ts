import { assert, describe, it } from "@effect/vitest";

import { selectCaaraCommand } from "./caaraCli.ts";

describe("Caara CLI dispatch", () => {
  it("selects status subcommand without changing default server startup args", () => {
    assert.deepStrictEqual(selectCaaraCommand({ args: ["status", "--port", "8799"] }), {
      _tag: "Status",
      args: ["--port", "8799"],
    });
    assert.deepStrictEqual(selectCaaraCommand({ args: ["--port", "8799"] }), {
      _tag: "Server",
      args: ["--port", "8799"],
    });
    assert.deepStrictEqual(selectCaaraCommand({ args: ["doctor", "--fix"] }), {
      _tag: "Doctor",
      args: ["--fix"],
    });
    assert.deepStrictEqual(selectCaaraCommand({ args: ["install-service", "--no-start"] }), {
      _tag: "InstallService",
      args: ["--no-start"],
    });
    assert.deepStrictEqual(selectCaaraCommand({ args: ["uninstall-service", "--purge"] }), {
      _tag: "UninstallService",
      args: ["--purge"],
    });
  });
});
