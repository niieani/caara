import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  type CaaraAgentApi,
  caaraAgentMaximumPromptBytes,
  resolveCaaraAgentPrompt,
  runCaaraAgentCancel,
  runCaaraAgentStart,
  runCaaraAgentWait,
} from "./caaraAgentCli.ts";
import { PortableSessionId, PortableTurnId } from "./portableAgentIdentity.ts";

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
              status: 202,
              body: {
                turnId: "portable-turn-00000000-0000-4000-8000-000000000001",
                sessionId: "session-1",
                status: "working",
                observationPath: "/observe/secret",
              },
            })),
          ),
        get: () => Effect.die("unused"),
      };

      const result = yield* runCaaraAgentStart({
        args: ["--host", "127.0.0.1", "--port", "8799"],
        prompt: "$(touch /tmp/never) ' <script>",
        target: "diagnostic/activity",
        cwd: "/workspace",
        driverOptions: { mode: "strict" },
        sessionId: "session-existing",
        api,
        env,
      });

      assert.strictEqual(result.status, "accepted");
      assert.deepStrictEqual(requests, [
        {
          url: "http://127.0.0.1:8799/agent/turns",
          body: {
            prompt: "$(touch /tmp/never) ' <script>",
            target: "diagnostic/activity",
            cwd: "/workspace",
            driverOptions: { mode: "strict" },
            sessionId: "session-existing",
          },
        },
      ]);
    }),
  );

  it.effect("returns only coarse working state or a terminal final answer", () =>
    Effect.gen(function* () {
      const requestedUrls: string[] = [];
      const workingApi: CaaraAgentApi = {
        post: () => Effect.die("unused"),
        get: (url) =>
          Effect.sync(() => requestedUrls.push(url)).pipe(
            Effect.map(() => ({
              status: 200,
              body: {
                status: "working",
                turnId: "portable-turn-00000000-0000-4000-8000-000000000001",
                sessionId: "portable-session-1",
                observationPath: "/observe/secret",
                commentary: "SENTINEL",
              },
            })),
          ),
      };
      const completedApi: CaaraAgentApi = {
        post: () => Effect.die("unused"),
        get: () =>
          Effect.succeed({
            status: 200,
            body: {
              status: "completed",
              finalAnswer: "safe final",
              reasoning: "SENTINEL",
            },
          }),
      };

      assert.deepStrictEqual(
        yield* runCaaraAgentWait({
          args: ["--port", "8799"],
          turnId: "portable-turn-00000000-0000-4000-8000-000000000001",
          timeoutMillis: 125,
          api: workingApi,
          env,
        }),
        {
          schemaVersion: 1,
          status: "working",
          turnId: PortableTurnId.make("portable-turn-00000000-0000-4000-8000-000000000001"),
          sessionId: PortableSessionId.make("portable-session-1"),
          observationUrl: "http://127.0.0.1:8799/observe/secret",
        },
      );
      assert.deepStrictEqual(requestedUrls, [
        "http://127.0.0.1:8799/agent/turns/portable-turn-00000000-0000-4000-8000-000000000001?timeoutMillis=125",
      ]);
      assert.deepStrictEqual(
        yield* runCaaraAgentWait({
          args: ["--port", "8799"],
          turnId: "portable-turn-00000000-0000-4000-8000-000000000001",
          api: completedApi,
          env,
        }),
        { schemaVersion: 1, status: "completed", finalAnswer: "safe final" },
      );
    }),
  );

  it.effect("cancels by turn identity and returns only outcome plus session reusability", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
      const api: CaaraAgentApi = {
        post: ({ url, body }) =>
          Effect.sync(() => requests.push({ url, body })).pipe(
            Effect.map(() => ({
              status: 200,
              body: {
                status: "cancelled",
                outcome: "Interrupted",
                sessionReusable: true,
                activity: "SENTINEL must be discarded",
              },
            })),
          ),
        get: () => Effect.die("unused"),
      };

      assert.deepStrictEqual(
        yield* runCaaraAgentCancel({
          args: ["--port", "8799"],
          turnId: "portable-turn-00000000-0000-4000-8000-000000000001",
          api,
          env,
        }),
        { schemaVersion: 1, status: "cancelled", outcome: "Interrupted", sessionReusable: true },
      );
      assert.deepStrictEqual(requests, [
        {
          url: "http://127.0.0.1:8799/agent/turns/portable-turn-00000000-0000-4000-8000-000000000001/cancel",
          body: {},
        },
      ]);
    }),
  );

  it.effect(
    "preserves direct, file, and stdin prompts exactly and enforces the size boundary",
    () =>
      Effect.gen(function* () {
        const promptFixture = { value: "line one\nλ $(touch /tmp/never) ' \" & | ;\n" } as const;
        const prompt = promptFixture.value;
        const reader = {
          file: () => Effect.succeed(prompt),
          stdin: Effect.succeed(prompt),
        };
        assert.strictEqual(
          yield* resolveCaaraAgentPrompt({ source: { _tag: "Direct", value: prompt }, reader }),
          prompt,
        );
        assert.strictEqual(
          yield* resolveCaaraAgentPrompt({ source: { _tag: "File", path: "/prompt" }, reader }),
          prompt,
        );
        assert.strictEqual(
          yield* resolveCaaraAgentPrompt({ source: { _tag: "Stdin" }, reader }),
          prompt,
        );
        const maximum = "x".repeat(caaraAgentMaximumPromptBytes);
        assert.strictEqual(
          yield* resolveCaaraAgentPrompt({ source: { _tag: "Direct", value: maximum }, reader }),
          maximum,
        );
        assert.strictEqual(
          (yield* Effect.result(
            resolveCaaraAgentPrompt({ source: { _tag: "Direct", value: `${maximum}x` }, reader }),
          ))._tag,
          "Failure",
        );
        const maximumUnicode = "λ".repeat(caaraAgentMaximumPromptBytes / 2);
        assert.strictEqual(
          yield* resolveCaaraAgentPrompt({
            source: { _tag: "Direct", value: maximumUnicode },
            reader,
          }),
          maximumUnicode,
        );
        assert.strictEqual(
          (yield* Effect.result(
            resolveCaaraAgentPrompt({
              source: { _tag: "Direct", value: `${maximumUnicode}λ` },
              reader,
            }),
          ))._tag,
          "Failure",
        );
      }),
  );
});
