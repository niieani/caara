import { assert, describe, it } from "@effect/vitest";

import { httpServerOptionsFromCaaraSettings, mockResponsesIdleTimeoutSeconds } from "./caaraApp.ts";
import { defaultCaaraSettingsValue } from "./caaraSettings.ts";

describe("Caara app layer settings", () => {
  it("maps server settings into Bun HTTP server options", () => {
    const options = httpServerOptionsFromCaaraSettings({
      settings: {
        ...defaultCaaraSettingsValue,
        host: "0.0.0.0",
        port: 8791,
      },
    });

    assert.deepStrictEqual(options, {
      hostname: "0.0.0.0",
      port: 8791,
      idleTimeout: mockResponsesIdleTimeoutSeconds,
    });
  });
});
