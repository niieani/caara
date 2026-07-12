import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect, Match, Option, Schedule, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import { runCaaraAgentCancel, runCaaraAgentStart, runCaaraAgentWait } from "./caaraAgentCli.ts";
import {
  PortableAgentCancelResult,
  PortableAgentErrorResult,
  PortableAgentStartResult,
  PortableAgentWaitResult,
} from "./caaraAgentContract.ts";
import { createCaaraAgentMcpServer } from "./caaraAgentMcp.ts";
import {
  CaaraSessionBinding,
  DurableExternalSession,
  makeDriverResumeCursor,
} from "./mockResponsesProvider/sessionDirectory.ts";
import {
  PortableAgentStartRequest,
  PortableAgentStartServiceResponse,
  PortableAgentWaitResponse,
} from "./portableAgentHttp.ts";
import { PortableSessionId } from "./portableAgentIdentity.ts";

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
        ...process.env,
        CAARA_PORTABLE_RETENTION_MILLIS: retentionMillis?.toString(),
        HOME: tempRoot,
        PATH: `${path.join(tempRoot, ".local", "bin")}:${process.env.PATH ?? ""}`,
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
    ({ serviceProcess }) =>
      Effect.sync(() => serviceProcess.kill()).pipe(
        Effect.andThen(() => Effect.promise(() => serviceProcess.exited)),
        Effect.asVoid,
      ),
  );

/** Executes the compiled CLI and captures its complete agent-facing process output. */
const runCliProcess = Effect.fnUntraced(function* ({
  executable,
  args,
  env = process.env,
  stdin,
}: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
}) {
  const stdinMode = Option.match(Option.fromUndefinedOr(stdin), {
    onNone: () => "ignore" as const,
    onSome: () => "pipe" as const,
  });
  const cliProcess = Bun.spawn([executable, ...args], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdinMode,
  });
  yield* Option.match(Option.fromUndefinedOr(stdin), {
    onNone: () => Effect.void,
    onSome: (inputText) =>
      Effect.gen(function* () {
        const input = cliProcess.stdin;
        assert.ok(input);
        yield* Effect.promise(() =>
          Promise.resolve(input.write(inputText)).then(() => input.end()),
        );
      }),
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

/** Decodes one exact JSON CLI error while asserting stderr and process status discipline. */
const decodeCliError = Effect.fnUntraced(function* ({
  result,
  exitCode,
}: {
  readonly result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
  readonly exitCode: number;
}) {
  assert.strictEqual(result.exitCode, exitCode, result.stderr);
  assert.strictEqual(result.stdout, "", result.stderr);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentErrorResult))(
    result.stderr.trim(),
  );
});

/** Runs compiled doctor and verifies the portable execution plus embedded viewer proof. */
const verifyCompiledPortableDoctor = Effect.fnUntraced(function* ({
  executable,
  port,
  stateRoot,
}: {
  readonly executable: string;
  readonly port: number;
  readonly stateRoot: string;
}) {
  const result = yield* runCliProcess({
    executable,
    args: ["doctor", "--host", "127.0.0.1", "--port", String(port)],
    env: {
      ...process.env,
      HOME: stateRoot,
      PATH: `${path.join(stateRoot, ".local", "bin")}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: stateRoot,
      XDG_STATE_HOME: stateRoot,
    },
  });
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.stdout, /portable diagnostic turn completed/u);
  assert.match(result.stdout, /loopback observation viewer served/u);
  assert.strictEqual(result.stdout.includes("diagnostic commentary"), false);
});

describe("portable Agent service process", () => {
  it.live(
    "keeps real diagnostic activity viewer-only across every MCP result and error",
    () => {
      const port = allocatePort();
      return withServiceProcess({
        port,
        use: ({ origin }) =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              const serviceArgs = ["--host", "127.0.0.1", "--port", String(port)];
              const server = createCaaraAgentMcpServer({
                operations: {
                  start: (input) => runCaaraAgentStart({ args: serviceArgs, ...input }),
                  wait: (input) => runCaaraAgentWait({ args: serviceArgs, ...input }),
                  cancel: (input) => runCaaraAgentCancel({ args: serviceArgs, ...input }),
                },
              });
              const client = new Client({ name: "caara-real-service-test", version: "1" });
              const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
              yield* Effect.tryPromise(() => server.connect(serverTransport));
              yield* Effect.tryPromise(() => client.connect(clientTransport));
              return { client, server };
            }),
            ({ client }) =>
              Effect.gen(function* () {
                const sentinel = `MCP-VIEWER-ONLY-${randomUUID()}`;
                const started = yield* Effect.tryPromise(() =>
                  client.callTool({
                    name: "caara_agent_start",
                    arguments: {
                      target: "diagnostic/hangs-until-cancel",
                      cwd: process.cwd(),
                      prompt: sentinel,
                      driverOptions: {
                        diagnostic_cancel: "interrupted",
                        diagnostic_activity_sentinel: sentinel,
                      },
                    },
                  }),
                );
                const start = yield* Schema.decodeUnknownEffect(PortableAgentStartResult)(
                  started.structuredContent,
                );
                const viewer = yield* fetchText({ url: start.observationUrl }).pipe(
                  Effect.filterOrFail((html) => html.includes(sentinel)),
                  Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
                );
                assert.ok(viewer.includes(sentinel));

                const failed = yield* Effect.tryPromise(() =>
                  client.callTool({
                    name: "caara_agent_wait",
                    arguments: { turnId: "malformed-turn-id" },
                  }),
                );
                const allMcpOutput = yield* Schema.encodeEffect(
                  Schema.fromJsonString(Schema.Unknown),
                )({ started, failed });
                assert.notMatch(allMcpOutput, new RegExp(sentinel, "u"));
                assert.strictEqual(failed.isError, true);
                assert.strictEqual(client.getServerCapabilities()?.resources, undefined);
                yield* runCaaraAgentCancel({
                  args: ["--host", "127.0.0.1", "--port", String(port)],
                  turnId: start.turnId,
                });
              }),
            Effect.fnUntraced(function* ({ client, server }) {
              yield* Effect.tryPromise(() => client.close());
              yield* Effect.tryPromise(() => server.close());
            }),
          ),
      });
    },
    30_000,
  );

  it.live(
    "compiled doctor executes a portable turn and verifies the loopback capability viewer",
    () =>
      Effect.gen(function* () {
        const port = allocatePort();
        const stateRoot = path.join(
          process.cwd(),
          "temp.local",
          "2026-07-12",
          `portable-doctor-${randomUUID()}`,
        );
        const driverBin = path.join(stateRoot, ".local", "bin");
        const claudePath = path.join(driverBin, "claude");
        yield* Effect.tryPromise(() => fs.mkdir(driverBin, { recursive: true }));
        yield* Effect.tryPromise(() => Bun.write(claudePath, "#!/bin/sh\nexit 0\n"));
        yield* Effect.tryPromise(() => fs.chmod(claudePath, 0o755));

        return yield* withServiceProcess({
          port,
          stateRoot,
          use: ({ executable }) => verifyCompiledPortableDoctor({ executable, port, stateRoot }),
        });
      }),
    30_000,
  );
  it.live(
    "preserves every prompt form and classifies public CLI request failures",
    () => {
      const port = allocatePort();
      const stateRoot = path.join(
        process.cwd(),
        "temp.local",
        "2026-07-12",
        `portable-cli-contract-${randomUUID()}`,
      );
      return withServiceProcess({
        port,
        stateRoot,
        use: ({ executable }) =>
          Effect.gen(function* () {
            const originArgs = ["--host", "127.0.0.1", "--port", String(port), "--json"];
            for (const helpArgs of [
              ["agent", "--help"],
              ["agent", "start", "--help"],
              ["agent", "wait", "--help"],
              ["agent", "cancel", "--help"],
            ]) {
              const help = yield* runCliProcess({ executable, args: helpArgs });
              assert.strictEqual(help.exitCode, 0, help.stderr);
              assert.strictEqual(help.stderr, "");
              assert.match(help.stdout, /USAGE|SUBCOMMANDS/u);
            }
            const promptFile = path.join(stateRoot, "prompt.txt");
            yield* Effect.promise(() => Bun.write(promptFile, "file\nλ $()"));
            const starts = [
              { args: ["--prompt", "direct\nλ $()"], prompt: "direct\nλ $()" },
              { args: ["--prompt-file", promptFile], prompt: "file\nλ $()" },
              { args: ["--stdin"], stdin: "stdin\nλ $()", prompt: "stdin\nλ $()" },
            ] as const;
            for (const start of starts) {
              const stdin = [start]
                .filter(
                  (candidate): candidate is typeof candidate & { readonly stdin: string } =>
                    "stdin" in candidate,
                )
                .map((candidate) => candidate.stdin)
                .at(0);
              const result = yield* runCliProcess({
                executable,
                args: [
                  "agent",
                  "start",
                  ...originArgs,
                  "--target",
                  "diagnostic/echo",
                  "--cwd",
                  process.cwd(),
                  ...start.args,
                ],
                stdin,
              });
              assert.strictEqual(result.exitCode, 10, result.stderr);
              assert.strictEqual(result.stderr, "");
              const accepted = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(PortableAgentStartResult),
              )(result.stdout.trim());
              assert.strictEqual(accepted.status, "accepted");
              const completed = yield* runCliProcess({
                executable,
                args: ["agent", "wait", accepted.turnId, ...originArgs],
              }).pipe(
                Effect.filterOrFail(
                  (waited) => waited.exitCode === 0,
                  (waited) => `Prompt fidelity wait exited ${waited.exitCode}: ${waited.stderr}`,
                ),
                Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
                Effect.flatMap(({ stdout }) =>
                  Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentWaitResult))(
                    stdout.trim(),
                  ),
                ),
              );
              const encodedPrompt = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([
                { type: "input_text", text: start.prompt },
              ]);
              assert.deepStrictEqual(completed, {
                schemaVersion: 1,
                status: "completed",
                finalAnswer: `Diagnostic echo current user input: ${encodedPrompt}`,
              });
            }

            const missingTarget = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "start",
                ...originArgs,
                "--cwd",
                process.cwd(),
                "--prompt",
                "missing target",
              ],
            }).pipe(Effect.flatMap((result) => decodeCliError({ result, exitCode: 64 })));
            assert.strictEqual(missingTarget.error.kind, "invalid_request");

            const parserFailures = [
              ["agent", "wait", ...originArgs],
              [
                "agent",
                "wait",
                ...originArgs,
                "--timeout-millis",
                "not-an-integer",
                "portable-turn-00000000-0000-4000-8000-000000000001",
              ],
              [
                "agent",
                "wait",
                ...originArgs,
                "--unknown",
                "portable-turn-00000000-0000-4000-8000-000000000001",
              ],
              ["agent", "start", ...originArgs, "--target"],
            ] as const;
            for (const args of parserFailures) {
              const parserFailure = yield* runCliProcess({ executable, args }).pipe(
                Effect.flatMap((result) => decodeCliError({ result, exitCode: 64 })),
              );
              assert.strictEqual(parserFailure.error.kind, "invalid_request");
            }

            const invalidCwd = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "start",
                ...originArgs,
                "--target",
                "diagnostic/activity",
                "--cwd",
                "relative/path",
                "--prompt",
                "invalid cwd",
              ],
            }).pipe(Effect.flatMap((result) => decodeCliError({ result, exitCode: 64 })));
            assert.strictEqual(invalidCwd.error.kind, "invalid_request");

            const missingTargetDriver = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "start",
                ...originArgs,
                "--target",
                "missing/model",
                "--cwd",
                process.cwd(),
                "--prompt",
                "missing driver",
              ],
            }).pipe(Effect.flatMap((result) => decodeCliError({ result, exitCode: 70 })));
            assert.strictEqual(missingTargetDriver.error.kind, "target_failure");

            const invalidDriverOption = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "start",
                ...originArgs,
                "--target",
                "diagnostic/activity",
                "--cwd",
                process.cwd(),
                "--option",
                "unsupported_option=value",
                "--prompt",
                "invalid option",
              ],
            }).pipe(Effect.flatMap((result) => decodeCliError({ result, exitCode: 70 })));
            assert.strictEqual(invalidDriverOption.error.kind, "target_failure");

            const malformedTurn = yield* runCliProcess({
              executable,
              args: ["agent", "wait", "malformed", ...originArgs],
            }).pipe(Effect.flatMap((result) => decodeCliError({ result, exitCode: 64 })));
            assert.strictEqual(malformedTurn.error.kind, "invalid_request");

            const unknownTurn = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "wait",
                "portable-turn-00000000-0000-4000-8000-000000000000",
                ...originArgs,
              ],
            }).pipe(Effect.flatMap((result) => decodeCliError({ result, exitCode: 66 })));
            assert.strictEqual(unknownTurn.error.kind, "unknown_resource");

            const failingStart = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "start",
                ...originArgs,
                "--target",
                "diagnostic/fails-after-partial",
                "--cwd",
                process.cwd(),
                "--prompt",
                "terminal failure",
              ],
            });
            assert.strictEqual(failingStart.exitCode, 10, failingStart.stderr);
            const failingAccepted = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(PortableAgentStartResult),
            )(failingStart.stdout.trim());
            const failedWait = yield* runCliProcess({
              executable,
              args: ["agent", "wait", failingAccepted.turnId, ...originArgs],
            }).pipe(
              Effect.filterOrFail(
                (waited) => waited.exitCode === 20,
                (waited) => `Terminal failure wait exited ${waited.exitCode}: ${waited.stderr}`,
              ),
              Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
            );
            assert.strictEqual(failedWait.stderr, "");
            assert.deepStrictEqual(
              yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentWaitResult))(
                failedWait.stdout.trim(),
              ),
              { schemaVersion: 1, status: "failed" },
            );

            const unavailablePort = allocatePort();
            const unavailable = yield* runCliProcess({
              executable,
              args: [
                "agent",
                "wait",
                "portable-turn-00000000-0000-4000-8000-000000000000",
                "--host",
                "127.0.0.1",
                "--port",
                String(unavailablePort),
                "--json",
              ],
            }).pipe(Effect.flatMap((result) => decodeCliError({ result, exitCode: 69 })));
            assert.strictEqual(unavailable.error.kind, "service_unavailable");
          }),
      });
    },
    20_000,
  );

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
                target: "diagnostic/hangs-until-cancel",
                cwd: process.cwd(),
                driverOptions: {
                  diagnostic_cancel: cancellationCase.mode,
                  diagnostic_activity_sentinel: prompt,
                },
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
                  "--json",
                  started.turnId,
                ],
              });
              assert.strictEqual(cancelled.exitCode, 21, cancelled.stderr);
              assert.notMatch(`${cancelled.stdout}${cancelled.stderr}`, new RegExp(prompt, "u"));
              assert.deepStrictEqual(
                yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentCancelResult))(
                  cancelled.stdout.trim(),
                ),
                {
                  schemaVersion: 1,
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
                schemaVersion: 1,
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
              assert.strictEqual(repeated.exitCode, 75);
              assert.match(
                `${repeated.stdout}${repeated.stderr}`,
                /already terminal or cancelling/u,
              );
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
              const selectedSessionId = yield* Schema.decodeUnknownEffect(
                Schema.optional(PortableSessionId),
              )(sessionId);
              const encodedRequest = yield* Schema.encodeEffect(
                Schema.fromJsonString(PortableAgentStartRequest),
              )({
                prompt: "portable continuity",
                target: "diagnostic/activity",
                cwd: process.cwd(),
                driverOptions: { diagnostic_activity_sentinel: "portable continuity" },
                sessionId: selectedSessionId,
              });
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
            assert.strictEqual(lost.response.status, 404);

            const overlap = yield* start(accepted.sessionId);
            assert.strictEqual(overlap.response.status, 404);

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
            assert.deepStrictEqual(bounded, {
              status: "working",
              turnId: accepted.turnId,
              sessionId: accepted.sessionId,
              observationPath: accepted.observationPath,
            });

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
              schemaVersion: 1,
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
            const resumedOverlapError = yield* Schema.decodeUnknownEffect(PortableAgentErrorResult)(
              resumedOverlap.body,
            );
            assert.strictEqual(resumedOverlapError.error.kind, "concurrency_conflict");
            assert.match(resumedOverlapError.error.message, /in-flight turn/iu);

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
              schemaVersion: 1,
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
              ({ binding }) => String(binding.bindingKey.codexThreadId) === accepted.sessionId,
            );
            const resumedBinding = resumedBindingFile?.binding;
            assert.strictEqual(String(resumedBinding?.createdFromTurnId), String(accepted.turnId));
            assert.strictEqual(String(resumedBinding?.lastTurnId), String(resumedAccepted.turnId));
            assert.ok(
              bindingFiles.some(
                ({ binding }) =>
                  String(binding.bindingKey.codexThreadId) === independentAccepted.sessionId,
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
            assert.deepStrictEqual(invalidResumeResult, { schemaVersion: 1, status: "failed" });
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
              target: "diagnostic/activity",
              cwd: process.cwd(),
              driverOptions: {},
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
                "--target",
                "diagnostic/activity",
                "--cwd",
                process.cwd(),
                "--option",
                `diagnostic_activity_sentinel=${sentinel}`,
                "--json",
                "--prompt",
                `line one\n${sentinel}`,
              ],
            });
            assert.strictEqual(startProcess.exitCode, 10);
            const start = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(PortableAgentStartResult),
            )(startProcess.stdout.trim());
            assert.deepStrictEqual(
              yield* Schema.decodeUnknownEffect(PortableAgentStartResult)(start),
              start,
            );
            assert.strictEqual(start.status, "accepted");
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
              args: [
                "agent",
                "wait",
                "--host",
                "127.0.0.1",
                "--port",
                String(port),
                "--json",
                start.turnId,
              ],
            }).pipe(
              Effect.filterOrFail(({ stdout }) => stdout.includes('"status":"completed"')),
              Effect.retry(Schedule.both(Schedule.spaced("25 millis"), Schedule.recurs(20))),
            );
            assert.strictEqual(waitProcess.exitCode, 0);
            const completed = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(PortableAgentWaitResult),
            )(waitProcess.stdout.trim());
            assert.deepStrictEqual(completed, {
              schemaVersion: 1,
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
                "--target",
                "diagnostic/activity",
                "--cwd",
                process.cwd(),
                "--json",
                "--prompt",
                "restart durable state",
              ],
            });
            const start = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(PortableAgentStartResult),
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
                    "--json",
                    start.turnId,
                  ],
                });
                assert.strictEqual(waited.exitCode, 0);
                const result = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(PortableAgentWaitResult),
                )(waited.stdout.trim());
                assert.deepStrictEqual(result, {
                  schemaVersion: 1,
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
              "--target",
              "diagnostic/hangs-until-cancel",
              "--cwd",
              process.cwd(),
              "--json",
              "--prompt",
              "working restart state",
            ],
          }).pipe(
            Effect.flatMap(({ stdout }) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentStartResult))(
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
                    "--json",
                    start.turnId,
                  ],
                });
                assert.strictEqual(waited.exitCode, 11);
                assert.deepStrictEqual(
                  yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PortableAgentWaitResult))(
                    waited.stdout.trim(),
                  ),
                  {
                    schemaVersion: 1,
                    status: "working",
                    turnId: start.turnId,
                    sessionId: start.sessionId,
                    observationUrl: start.observationUrl,
                  },
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
                assert.strictEqual(cancelledAfterRestart.exitCode, 75);
                assert.match(
                  `${cancelledAfterRestart.stdout}${cancelledAfterRestart.stderr}`,
                  /working without a live cancellation handle/u,
                );
              }),
          }),
        ),
      );
    },
    15_000,
  );
});
