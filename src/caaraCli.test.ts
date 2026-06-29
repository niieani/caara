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
  });
});
