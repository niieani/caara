import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { type CaaraAgentApi, runCaaraAgentStart, runCaaraAgentWait } from "./caaraAgentCli.ts";

/** Minimal environment used to keep command settings deterministic. */
const env = { HOME: "/tmp", XDG_CONFIG_HOME: "/tmp", XDG_STATE_HOME: "/tmp" };

describe("portable Agent CLI commands", () => {
  it.effect("submits the prompt only as a JSON value and decodes immediate identifiers", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
      const api: CaaraAgentApi = {
        post: ({ url, body }) =>
          Effect.sync(() => requests.push({ url, body })).pipe(
            Effect.map(() => ({
              turnId: "turn-1",
              sessionId: "session-1",
              status: "working",
              observationPath: "/observe/secret",
            })),
          ),
        get: () => Effect.die("unused"),
      };

      const result = yield* runCaaraAgentStart({
        args: ["--host", "127.0.0.1", "--port", "8799"],
        prompt: "$(touch /tmp/never) ' <script>",
        api,
        env,
      });

      assert.strictEqual(result.status, "working");
      assert.deepStrictEqual(requests, [
        {
          url: "http://127.0.0.1:8799/agent/turns",
          body: { prompt: "$(touch /tmp/never) ' <script>" },
        },
      ]);
    }),
  );

  it.effect("returns only coarse working state or a terminal final answer", () =>
    Effect.gen(function* () {
      const workingApi: CaaraAgentApi = {
        post: () => Effect.die("unused"),
        get: () => Effect.succeed({ status: "working", commentary: "SENTINEL" }),
      };
      const completedApi: CaaraAgentApi = {
        post: () => Effect.die("unused"),
        get: () =>
          Effect.succeed({
            status: "completed",
            finalAnswer: "safe final",
            reasoning: "SENTINEL",
          }),
      };

      assert.deepStrictEqual(
        yield* runCaaraAgentWait({
          args: ["--port", "8799"],
          turnId: "turn-1",
          api: workingApi,
          env,
        }),
        { status: "working" },
      );
      assert.deepStrictEqual(
        yield* runCaaraAgentWait({
          args: ["--port", "8799"],
          turnId: "turn-1",
          api: completedApi,
          env,
        }),
        { status: "completed", finalAnswer: "safe final" },
      );
    }),
  );
});
