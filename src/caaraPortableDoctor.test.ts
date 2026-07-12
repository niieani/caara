import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  portableDoctorFailureMessage,
  runPortableDoctorCheck,
  type CaaraPortableDoctorProbe,
} from "./caaraPortableDoctor.ts";

/** Successful portable capability probe used by doctor contract tests. */
const successfulProbe: CaaraPortableDoctorProbe = {
  probe: () => Effect.succeed({ observationUrl: "http://127.0.0.1:8787/observe/capability" }),
};

describe("Caara portable delegation doctor", () => {
  it.effect("reports portable turn execution and loopback viewer capability", () =>
    Effect.gen(function* () {
      const result = yield* runPortableDoctorCheck({
        cwd: "/workspace",
        origin: "http://127.0.0.1:8787",
        probe: successfulProbe,
      });

      assert.strictEqual(result.exitCode, 0);
      assert.match(result.message, /portable diagnostic turn completed/u);
      assert.match(result.message, /loopback observation viewer served/u);
      assert.strictEqual(result.message.includes("capability"), false);
    }),
  );

  it.effect("reports explicit service and execution-path repair prerequisites", () =>
    Effect.gen(function* () {
      const result = yield* runPortableDoctorCheck({
        cwd: "/workspace",
        origin: "http://127.0.0.1:8787",
        probe: {
          probe: () => Effect.fail("Connection refused"),
        },
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(
        result.message,
        portableDoctorFailureMessage({ cause: "Connection refused" }),
      );
      assert.match(result.message, /caara install-service/u);
      assert.match(result.message, /service execution path/u);
      assert.match(result.message, /caara doctor --fix/u);
    }),
  );
});
