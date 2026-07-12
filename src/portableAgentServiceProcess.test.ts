import { randomUUID } from "node:crypto";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Schedule, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import {
  PortableAgentStartResponse,
  PortableAgentStartServiceResponse,
  PortableAgentWaitResponse,
} from "./portableAgentHttp.ts";

/** Allocates an OS-selected TCP port without guessing a random port. */
const allocatePort = (): number => {
  const allocator = Bun.serve({ port: 0, fetch: () => new Response("port allocator") });
  const port = allocator.port ?? 0;
  void allocator.stop(true);
  return port;
};

/** Fetches one URL and fails explicitly for non-success responses. */
const fetchText = Effect.fnUntraced(function* ({ url }: { readonly url: string }) {
  const response = yield* Effect.tryPromise({
    try: () => fetch(url),
    catch: String,
  });
  return yield* Match.value(response.ok).pipe(
    Match.when(true, () => Effect.tryPromise({ try: () => response.text(), catch: String })),
    Match.orElse(() => Effect.fail(`HTTP ${response.status}`)),
  );
});

/** Waits causally until the service health endpoint accepts requests. */
const awaitService = ({ origin }: { readonly origin: string }) =>
  fetchText({ url: `${origin}/health` }).pipe(
    Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(80))),
  );

/** Runs one operation while owning a real Caara service child process. */
const withServiceProcess = <A, E, R>({
  port,
  use,
}: {
  readonly port: number;
  readonly use: (input: {
    readonly origin: string;
    readonly executable: string;
  }) => EffectContract<A, E, R>;
}) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const tempRoot = path.join(
        process.cwd(),
        "temp.local",
        "2026-07-12",
        `portable-service-${randomUUID()}`,
      );
      const executable = path.join(tempRoot, "caara-test");
      const env = {
        HOME: tempRoot,
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: tempRoot,
        XDG_STATE_HOME: tempRoot,
      };
      const build = Bun.spawn(
        ["bun", "build", "--compile", "src/caara.ts", "--outfile", executable],
        { cwd: process.cwd(), env, stdout: "ignore", stderr: "ignore" },
      );
      const buildExitCode = yield* Effect.promise(() => build.exited);
      yield* Effect.succeed(buildExitCode).pipe(
        Effect.filterOrFail(
          (exitCode) => exitCode === 0,
          () => `Compiled Caara CLI build exited ${buildExitCode}.`,
        ),
      );
      const serviceProcess = Bun.spawn(
        [executable, "--host", "127.0.0.1", "--port", String(port)],
        {
          cwd: process.cwd(),
          env,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      return { executable, serviceProcess };
    }),
    ({ executable }) => {
      const origin = `http://127.0.0.1:${port}`;
      return awaitService({ origin }).pipe(Effect.flatMap(() => use({ executable, origin })));
    },
    ({ serviceProcess }) => Effect.sync(() => serviceProcess.kill()),
  );

/** Executes the compiled CLI and captures its complete agent-facing process output. */
const runCliProcess = Effect.fnUntraced(function* ({
  executable,
  args,
}: {
  readonly executable: string;
  readonly args: readonly string[];
}) {
  const cliProcess = Bun.spawn([executable, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([
      cliProcess.exited,
      new Response(cliProcess.stdout).text(),
      new Response(cliProcess.stderr).text(),
    ]),
  );
  return { exitCode, stdout, stderr };
});

describe("portable Agent service process", () => {
  it.live("proves CLI start, live viewer, final-only wait, and capability blindness", () => {
    const port = allocatePort();
    return withServiceProcess({
      port,
      use: ({ executable, origin }) =>
        Effect.gen(function* () {
          const hostileHostBody = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
            prompt: "host-header-capability-test",
          });
          const hostileHostResponse = yield* Effect.tryPromise({
            try: () =>
              fetch(`${origin}/agent/turns`, {
                method: "POST",
                headers: { "content-type": "application/json", host: "attacker.example" },
                body: hostileHostBody,
              }),
            catch: String,
          });
          const hostileHostStart = yield* Effect.tryPromise({
            try: () => hostileHostResponse.json(),
            catch: String,
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PortableAgentStartServiceResponse)));
          assert.match(hostileHostStart.observationPath, /^\/observe\//u);
          assert.strictEqual(hostileHostStart.observationPath.includes("attacker.example"), false);

          const sentinel = ["strict-blindness", "λ-$(touch /tmp/never)", "sentinel"].join("-");
          const startProcess = yield* runCliProcess({
            executable,
            args: [
              "agent",
              "start",
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
              "--prompt",
              `line one\n${sentinel}`,
            ],
          });
          assert.strictEqual(startProcess.exitCode, 0);
          const start = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(PortableAgentStartResponse),
          )(startProcess.stdout.trim());
          assert.deepStrictEqual(
            yield* Schema.decodeUnknownEffect(PortableAgentStartResponse)(start),
            start,
          );
          assert.strictEqual(start.status, "working");
          assert.match(start.observationUrl, new RegExp(`^${origin}/observe/`, "u"));

          const liveHtml = yield* fetchText({ url: start.observationUrl }).pipe(
            Effect.filterOrFail(
              (html) => html.includes(sentinel) && html.includes("diagnostic-sentinel-tool"),
            ),
            Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
          );
          assert.match(liveHtml, /Reading src\/server\.ts/u);
          assert.ok(liveHtml.includes(sentinel));
          assert.match(liveHtml, /Permission denied: diagnostic-sentinel-tool/u);

          const waitProcess = yield* runCliProcess({
            executable,
            args: ["agent", "wait", "--host", "127.0.0.1", "--port", String(port), start.turnId],
          }).pipe(
            Effect.filterOrFail(({ stdout }) => stdout.includes('"status":"completed"')),
            Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
          );
          assert.strictEqual(waitProcess.exitCode, 0);
          const completed = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(PortableAgentWaitResponse),
          )(waitProcess.stdout.trim());
          assert.deepStrictEqual(completed, {
            status: "completed",
            finalAnswer: "Diagnostic activity completed diagnostic/activity",
          });
          assert.strictEqual(
            /Reading|Editing|reasoning|Permission denied|sentinel/iu.test(
              `${startProcess.stdout}${startProcess.stderr}${waitProcess.stdout}${waitProcess.stderr}`,
            ),
            false,
          );

          const finalHtml = yield* fetchText({ url: start.observationUrl });
          assert.match(finalHtml, /Status: completed/u);
          assert.match(finalHtml, /Final answer/u);
          assert.match(finalHtml, /Diagnostic activity completed diagnostic\/activity/u);

          const invalid = yield* Effect.tryPromise({
            try: () => fetch(`${origin}/observe/invalid-capability`),
            catch: String,
          });
          const tampered = yield* Effect.tryPromise({
            try: () => fetch(`${start.observationUrl}-tampered`),
            catch: String,
          });
          assert.strictEqual(invalid.status, 404);
          assert.strictEqual(tampered.status, 404);
          assert.strictEqual(yield* Effect.promise(() => invalid.text()), "Not found");
          assert.strictEqual(yield* Effect.promise(() => tampered.text()), "Not found");
        }),
    });
  });
});
