import { randomUUID } from "node:crypto";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Schedule, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import { runCaaraAgentWait } from "./caaraAgentCli.ts";
import {
  CaaraSessionBinding,
  DurableExternalSession,
  makeDriverResumeCursor,
} from "./mockResponsesProvider/sessionDirectory.ts";
import {
  PortableAgentCancelResponse,
  PortableAgentStartResponse,
  PortableAgentStartRequest,
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
  retentionMillis,
  stateRoot,
  use,
}: {
  readonly port: number;
  readonly retentionMillis?: number;
  readonly stateRoot?: string;
  readonly use: (input: {
    readonly origin: string;
    readonly executable: string;
  }) => EffectContract<A, E, R>;
}) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const tempRoot =
        stateRoot ??
        path.join(process.cwd(), "temp.local", "2026-07-12", `portable-service-${randomUUID()}`);
      const executable = path.join(tempRoot, "caara-test");
      const env = {
        CAARA_PORTABLE_RETENTION_MILLIS: retentionMillis?.toString(),
        HOME: tempRoot,
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: tempRoot,
        XDG_STATE_HOME: tempRoot,
      };
      const executableExists = yield* Effect.promise(() => Bun.file(executable).exists());
      const buildCommands = [
        ["bun", "build", "--compile", "src/caara.ts", "--outfile", executable],
      ].filter(() => !executableExists);
      yield* Effect.forEach(
        buildCommands,
        (command) =>
          Effect.sync(() =>
            Bun.spawn(command, {
              cwd: process.cwd(),
              env,
              stdout: "ignore",
              stderr: "ignore",
            }),
          ).pipe(
            Effect.flatMap((build) => Effect.promise(() => build.exited)),
            Effect.filterOrFail(
              (exitCode) => exitCode === 0,
              (exitCode) => `Compiled Caara CLI build exited ${exitCode}.`,
            ),
          ),
        { discard: true },
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
  it.live(
    "cancels every diagnostic outcome without exposing activity and applies binding policy",
    () => {
      const port = allocatePort();
      const stateRoot = path.join(
        process.cwd(),
        "temp.local",
        "2026-07-12",
        `portable-cancel-${randomUUID()}`,
      );
      return withServiceProcess({
        port,
        stateRoot,
        use: ({ executable, origin }) =>
          Effect.gen(function* () {
            const cases = [
              { mode: "interrupted", outcome: "Interrupted", reusable: true },
              { mode: "abandoned_reusable", outcome: "Abandoned", reusable: true },
              { mode: "abandoned_nonreusable", outcome: "Abandoned", reusable: false },
              { mode: "terminated", outcome: "Terminated", reusable: false },
            ] as const;
            const expectedSessionBindings = new Map<string, boolean>();
            for (const cancellationCase of cases) {
              const prompt = `PRIVATE-ACTIVITY-${cancellationCase.mode}`;
              const encoded = yield* Schema.encodeEffect(
                Schema.fromJsonString(PortableAgentStartRequest),
              )({
                prompt,
                sessionId: undefined,
                diagnosticCancellationMode: cancellationCase.mode,
              });
              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch(`${origin}/agent/turns`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: encoded,
                  }),
                catch: String,
              });
              const started = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: String,
              }).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(PortableAgentStartServiceResponse)),
              );
              expectedSessionBindings.set(started.sessionId, cancellationCase.reusable);
              const liveObservation = yield* fetchText({
                url: `${origin}${started.observationPath}`,
              }).pipe(
                Effect.filterOrFail((html) => html.includes(prompt)),
                Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
              );
              assert.ok(liveObservation.includes(prompt));
              const cancelled = yield* runCliProcess({
                executable,
                args: [
                  "agent",
                  "cancel",
                  "--host",
                  "127.0.0.1",
                  "--port",
                  String(port),
                  started.turnId,
                ],
              });
              assert.strictEqual(cancelled.exitCode, 0, cancelled.stderr);
              assert.notMatch(`${cancelled.stdout}${cancelled.stderr}`, new RegExp(prompt, "u"));
              assert.deepStrictEqual(
                yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(PortableAgentCancelResponse),
                )(cancelled.stdout.trim()),
                {
                  status: "cancelled",
                  outcome: cancellationCase.outcome,
                  sessionReusable: cancellationCase.reusable,
                },
              );
              const waited = yield* runCaaraAgentWait({
                args: ["--host", "127.0.0.1", "--port", String(port)],
                turnId: started.turnId,
                env: process.env,
              });
              assert.deepStrictEqual(waited, {
                status: "cancelled",
                outcome: cancellationCase.outcome,
                sessionReusable: cancellationCase.reusable,
              });
              const observation = yield* fetchText({ url: `${origin}${started.observationPath}` });
              assert.match(observation, /Status: cancelled/u);
              assert.match(observation, new RegExp(`Outcome: ${cancellationCase.outcome}`, "u"));
              assert.match(
                observation,
                new RegExp(`Session reusable: ${cancellationCase.reusable}`, "u"),
              );
              const repeated = yield* runCliProcess({
                executable,
                args: [
                  "agent",
                  "cancel",
                  "--host",
                  "127.0.0.1",
                  "--port",
                  String(port),
                  started.turnId,
                ],
              });
              assert.notStrictEqual(repeated.exitCode, 0);
              assert.match(`${repeated.stdout}${repeated.stderr}`, /HTTP 409/u);
            }

            const sessionDirectory = path.join(
              stateRoot,
              "caara",
              "sessions",
              "diagnostic",
              "diagnostic",
            );
            const bindingFiles = yield* Effect.promise(() =>
              Array.fromAsync(new Bun.Glob("*.json").scan(sessionDirectory)),
            );
            assert.strictEqual(bindingFiles.length, 2);
            const bindings = yield* Effect.forEach(bindingFiles, (file) =>
              Effect.promise(() => Bun.file(path.join(sessionDirectory, file)).text()).pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(Schema.fromJsonString(CaaraSessionBinding)),
                ),
              ),
            );
            for (const [sessionId, expected] of expectedSessionBindings) {
              assert.strictEqual(
                bindings.some((binding) => binding.bindingKey.codexThreadId === sessionId),
                expected,
              );
            }
          }),
      });
    },
    15_000,
  );

  it.live(
    "resumes explicit sessions, rejects overlap, and leaves bounded waits non-cancelling",
    () => {
      const port = allocatePort();
      const stateRoot = path.join(
        process.cwd(),
        "temp.local",
        "2026-07-12",
        `portable-session-${randomUUID()}`,
      );
      return withServiceProcess({
        port,
        stateRoot,
        use: ({ origin }) =>
          Effect.gen(function* () {
            const start = Effect.fnUntraced(function* (sessionId?: string) {
              const encodedRequest = yield* Schema.encodeEffect(
                Schema.fromJsonString(PortableAgentStartRequest),
              )({ prompt: "portable continuity", sessionId });
              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch(`${origin}/agent/turns`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: encodedRequest,
                  }),
                catch: String,
              });
              const body = yield* Effect.tryPromise({ try: () => response.json(), catch: String });
              return { response, body };
            });

            const first = yield* start();
            assert.strictEqual(first.response.status, 200);
            const accepted = yield* Schema.decodeUnknownEffect(PortableAgentStartServiceResponse)(
              first.body,
            );

            const lost = yield* start("portable-session-lost");
            assert.strictEqual(lost.response.status, 409);

            const overlap = yield* start(accepted.sessionId);
            assert.strictEqual(overlap.response.status, 409);

            const independent = yield* start();
            assert.strictEqual(independent.response.status, 200);
            const independentAccepted = yield* Schema.decodeUnknownEffect(
              PortableAgentStartServiceResponse,
            )(independent.body);
            assert.notStrictEqual(independentAccepted.sessionId, accepted.sessionId);

            const bounded = yield* Effect.tryPromise({
              try: () => fetch(`${origin}/agent/turns/${accepted.turnId}?timeoutMillis=1`),
              catch: String,
            }).pipe(
              Effect.flatMap((response) =>
                Effect.tryPromise({ try: () => response.json(), catch: String }),
              ),
              Effect.flatMap(Schema.decodeUnknownEffect(PortableAgentWaitResponse)),
            );
            assert.deepStrictEqual(bounded, { status: "working" });

            const firstCompleted = yield* runCaaraAgentWait({
              args: ["--host", "127.0.0.1", "--port", String(port)],
              turnId: accepted.turnId,
              timeoutMillis: 500,
              env: process.env,
            }).pipe(
              Effect.filterOrFail((result) => result.status === "completed"),
              Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
            );
            assert.deepStrictEqual(firstCompleted, {
              status: "completed",
              finalAnswer: "Diagnostic activity completed diagnostic/activity",
            });

            const resumed = yield* start(accepted.sessionId);
            assert.strictEqual(resumed.response.status, 200);
            const resumedAccepted = yield* Schema.decodeUnknownEffect(
              PortableAgentStartServiceResponse,
            )(resumed.body);
            assert.strictEqual(resumedAccepted.sessionId, accepted.sessionId);
            const resumedOverlap = yield* start(accepted.sessionId);
            assert.strictEqual(resumedOverlap.response.status, 409);
            const resumedOverlapError = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ error: Schema.String }),
            )(resumedOverlap.body);
            assert.match(resumedOverlapError.error, /in-flight turn/iu);

            const concurrentIndependent = yield* start();
            assert.strictEqual(concurrentIndependent.response.status, 200);

            const resumedCompleted = yield* runCaaraAgentWait({
              args: ["--host", "127.0.0.1", "--port", String(port)],
              turnId: resumedAccepted.turnId,
              timeoutMillis: 500,
              env: process.env,
            }).pipe(
              Effect.filterOrFail((result) => result.status === "completed"),
              Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
            );
            assert.deepStrictEqual(resumedCompleted, {
              status: "completed",
              finalAnswer: "Diagnostic activity resumed the prior opaque session",
            });
            assert.deepStrictEqual(
              yield* runCaaraAgentWait({
                args: ["--host", "127.0.0.1", "--port", String(port)],
                turnId: resumedAccepted.turnId,
                timeoutMillis: 1,
                env: process.env,
              }),
              resumedCompleted,
            );

            const sessionDirectory = path.join(
              stateRoot,
              "caara",
              "sessions",
              "diagnostic",
              "diagnostic",
            );
            const files = yield* Effect.promise(() =>
              Array.fromAsync(new Bun.Glob("*.json").scan(sessionDirectory)),
            );
            const bindingFiles = yield* Effect.forEach(files, (file) =>
              Effect.promise(() => Bun.file(path.join(sessionDirectory, file)).text()).pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(Schema.fromJsonString(CaaraSessionBinding)),
                ),
                Effect.map((binding) => ({ binding, file })),
              ),
            );
            const resumedBindingFile = bindingFiles.find(
              ({ binding }) => binding.bindingKey.codexThreadId === accepted.sessionId,
            );
            const resumedBinding = resumedBindingFile?.binding;
            assert.strictEqual(String(resumedBinding?.createdFromTurnId), String(accepted.turnId));
            assert.strictEqual(String(resumedBinding?.lastTurnId), String(resumedAccepted.turnId));
            assert.ok(
              bindingFiles.some(
                ({ binding }) => binding.bindingKey.codexThreadId === independentAccepted.sessionId,
              ),
            );

            assert.ok(resumedBinding);
            const corruptedBinding = new CaaraSessionBinding({
              ...resumedBinding,
              externalSession: new DurableExternalSession({
                driverResumeCursor: makeDriverResumeCursor("invalid-opaque-cursor"),
              }),
            });
            assert.ok(resumedBindingFile);
            const encodedCorruptedBinding = yield* Schema.encodeEffect(
              Schema.fromJsonString(CaaraSessionBinding),
            )(corruptedBinding);
            yield* Effect.promise(() =>
              Bun.write(
                path.join(sessionDirectory, resumedBindingFile.file),
                encodedCorruptedBinding,
              ),
            );
            const invalidResume = yield* start(accepted.sessionId);
            assert.strictEqual(invalidResume.response.status, 200);
            const invalidResumeAccepted = yield* Schema.decodeUnknownEffect(
              PortableAgentStartServiceResponse,
            )(invalidResume.body);
            const invalidResumeResult = yield* runCaaraAgentWait({
              args: ["--host", "127.0.0.1", "--port", String(port)],
              turnId: invalidResumeAccepted.turnId,
              timeoutMillis: 500,
              env: process.env,
            }).pipe(
              Effect.filterOrFail((result) => result.status === "failed"),
              Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
            );
            assert.deepStrictEqual(invalidResumeResult, { status: "failed" });
            const persistedAfterFailure = yield* Effect.promise(() =>
              Bun.file(path.join(sessionDirectory, resumedBindingFile.file)).text(),
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(CaaraSessionBinding)),
              ),
            );
            assert.strictEqual(
              Match.value(persistedAfterFailure.externalSession).pipe(
                Match.tags({
                  Durable: ({ driverResumeCursor }) => driverResumeCursor,
                  Ephemeral: () => "ephemeral",
                }),
                Match.exhaustive,
              ),
              "invalid-opaque-cursor",
            );
          }),
      });
    },
    15_000,
  );

  it.live(
    "proves CLI start, live viewer, final-only wait, and capability blindness",
    () => {
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
            assert.strictEqual(
              hostileHostStart.observationPath.includes("attacker.example"),
              false,
            );

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
    },
    15_000,
  );

  it.live(
    "recovers completed wait and capability pages after service restart",
    () => {
      const port = allocatePort();
      const retentionMillis = 4_000;
      const stateRoot = path.join(
        process.cwd(),
        "temp.local",
        "2026-07-12",
        `portable-restart-${randomUUID()}`,
      );
      return withServiceProcess({
        port,
        retentionMillis,
        stateRoot,
        use: ({ executable }) =>
          Effect.gen(function* () {
            const started = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "start",
                "--host",
                "127.0.0.1",
                "--port",
                String(port),
                "--prompt",
                "restart durable state",
              ],
            });
            const start = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(PortableAgentStartResponse),
            )(started.stdout.trim());
            yield* runCaaraAgentWait({
              args: ["--host", "127.0.0.1", "--port", String(port)],
              turnId: start.turnId,
              env: process.env,
            }).pipe(
              Effect.filterOrFail((result) => result.status === "completed"),
              Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
            );
            return start;
          }),
      }).pipe(
        Effect.flatMap((start) =>
          withServiceProcess({
            port,
            retentionMillis,
            stateRoot,
            use: ({ executable, origin }) =>
              Effect.gen(function* () {
                const waited = yield* runCliProcess({
                  executable,
                  args: [
                    "agent",
                    "wait",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    String(port),
                    start.turnId,
                  ],
                });
                assert.strictEqual(waited.exitCode, 0);
                const result = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(PortableAgentWaitResponse),
                )(waited.stdout.trim());
                assert.deepStrictEqual(result, {
                  status: "completed",
                  finalAnswer: "Diagnostic activity completed diagnostic/activity",
                });
                const html = yield* fetchText({ url: start.observationUrl });
                assert.match(html, /Status: completed/u);
                assert.match(html, /Diagnostic activity completed diagnostic\/activity/u);

                const capability = start.observationUrl.split("/").at(-1) ?? "";
                const durableTurn = yield* Effect.tryPromise({
                  try: () =>
                    Bun.file(
                      path.join(
                        stateRoot,
                        "caara",
                        "portable-turns",
                        `${encodeURIComponent(start.turnId)}.json`,
                      ),
                    ).text(),
                  catch: String,
                });
                assert.strictEqual(durableTurn.includes(capability), false);

                const sessionBindingPath = path.join(
                  stateRoot,
                  "caara",
                  "sessions",
                  "retention-sentinel.json",
                );
                yield* Effect.tryPromise({
                  try: () => Bun.write(sessionBindingPath, "session binding sentinel"),
                  catch: String,
                });

                // Timer-contract assertion: expiry is measured from turn acceptance using the live
                // service clock, so the process must cross the configured retention boundary.
                yield* Effect.sleep(`${retentionMillis + 100} millis`);
                const expired = yield* Effect.tryPromise({
                  try: () => fetch(start.observationUrl),
                  catch: String,
                });
                const invalid = yield* Effect.tryPromise({
                  try: () => fetch(`${origin}/observe/invalid-capability`),
                  catch: String,
                });
                assert.strictEqual(expired.status, invalid.status);
                assert.strictEqual(expired.status, 404);
                assert.strictEqual(yield* Effect.promise(() => expired.text()), "Not found");
                assert.strictEqual(yield* Effect.promise(() => invalid.text()), "Not found");
                assert.strictEqual(
                  yield* Effect.tryPromise({
                    try: () => Bun.file(sessionBindingPath).text(),
                    catch: String,
                  }),
                  "session binding sentinel",
                );
              }),
          }),
        ),
      );
    },
    15_000,
  );

  it.live(
    "recovers working state without reconstructing the external session",
    () => {
      const port = allocatePort();
      const retentionMillis = 5_000;
      const stateRoot = path.join(
        process.cwd(),
        "temp.local",
        "2026-07-12",
        `portable-working-restart-${randomUUID()}`,
      );
      return withServiceProcess({
        port,
        retentionMillis,
        stateRoot,
        use: ({ executable }) =>
          runCliProcess({
            executable,
            args: [
              "agent",
              "start",
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
              "--prompt",
              "working restart state",
            ],
          }).pipe(
            Effect.flatMap(({ stdout }) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentStartResponse))(
                stdout.trim(),
              ),
            ),
          ),
      }).pipe(
        Effect.flatMap((start) =>
          withServiceProcess({
            port,
            retentionMillis,
            stateRoot,
            use: ({ executable }) =>
              Effect.gen(function* () {
                const waited = yield* runCliProcess({
                  executable,
                  args: [
                    "agent",
                    "wait",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    String(port),
                    start.turnId,
                  ],
                });
                assert.strictEqual(waited.exitCode, 0);
                assert.deepStrictEqual(
                  yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(PortableAgentWaitResponse),
                  )(waited.stdout.trim()),
                  { status: "working" },
                );
                assert.match(yield* fetchText({ url: start.observationUrl }), /Status: working/u);
                const cancelledAfterRestart = yield* runCliProcess({
                  executable,
                  args: [
                    "agent",
                    "cancel",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    String(port),
                    start.turnId,
                  ],
                });
                assert.notStrictEqual(cancelledAfterRestart.exitCode, 0);
                assert.match(
                  `${cancelledAfterRestart.stdout}${cancelledAfterRestart.stderr}`,
                  /HTTP 409/u,
                );
              }),
          }),
        ),
      );
    },
    15_000,
  );
});
