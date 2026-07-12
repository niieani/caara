import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";

import {
  type CaaraAgentApi,
  runCaaraAgentCancel,
  runCaaraAgentStart,
  runCaaraAgentWait,
} from "../caaraAgentCli.ts";
import { CaaraSettings, defaultCaaraSettingsValue } from "../caaraSettings.ts";
import { RelayLogger } from "../mockResponsesProvider/relayLogger.ts";
import { sessionDirectoryBunTestLayer } from "../mockResponsesProvider/sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "../mockResponsesProvider/turnConcurrency.ts";
import { portableAgentRoutesLayerFromTurns } from "../portableAgentHttp.ts";
import { portableAgentTurnsLive } from "../portableAgentTurn.ts";
import { antigravityCliDriverLayer } from "./driver.ts";
import { fakeAgyFixture, fakeAgyScript } from "./fakeAgyScript.ts";
import { AntigravityCliSettings } from "./settings.ts";

/** Stable workspace passed through the public portable working-directory contract. */
const projectRoot = process.cwd();

/** Explicit test failure used for fake executable filesystem operations. */
class AntigravityPortableTestError extends Schema.TaggedErrorClass<AntigravityPortableTestError>()(
  "AntigravityPortableTestError",
  { message: Schema.String },
) {}

/** Isolated fake Antigravity process boundary for one portable test. */
interface PortableAgyFixture {
  readonly executable: string;
  readonly homeDir: string;
  readonly invocationLog: string;
  readonly stateDir: string;
}

/** Captured fake `agy` invocation fields asserted at the process boundary. */
const FakeAgyInvocation = Schema.Struct({
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  prompt: Schema.String,
});

/** Converts unknown fixture IO failures into a typed test failure. */
const fixtureError = (cause: unknown): AntigravityPortableTestError =>
  new AntigravityPortableTestError({ message: String(cause) });

/** Creates an isolated executable, HOME, invocation journal, and Caara state directory. */
const makeFixture = Effect.fnUntraced(function* () {
  const root = path.join(
    projectRoot,
    "temp.local",
    "2026-07-12",
    `antigravity-portable-${randomUUID()}`,
  );
  const binDir = path.join(root, "bin");
  const executable = path.join(binDir, "agy");
  yield* Effect.tryPromise({
    try: () => fs.mkdir(binDir, { recursive: true }),
    catch: fixtureError,
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(executable, fakeAgyScript, { mode: 0o755 }),
    catch: fixtureError,
  });
  return {
    executable,
    homeDir: path.join(root, "home"),
    invocationLog: path.join(root, "invocations.jsonl"),
    stateDir: path.join(root, "state"),
  } satisfies PortableAgyFixture;
});

/** Reads fake process invocations from its append-only boundary journal. */
const readInvocations = Effect.fnUntraced(function* ({
  fixture,
}: {
  readonly fixture: PortableAgyFixture;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(fixture.invocationLog, "utf8"),
    catch: fixtureError,
  });
  return yield* Effect.forEach(
    content.split("\n").filter((line) => line.length > 0),
    (line) => Schema.decodeEffect(Schema.fromJsonString(FakeAgyInvocation))(line),
  );
});

/** Returns the value immediately following one captured process argument. */
const argumentValue = ({
  args,
  name,
}: {
  readonly args: readonly string[];
  readonly name: string;
}): string | undefined => args.at(args.indexOf(name) + 1);

/** Real HTTP adapter matching the public CLI's service boundary. */
const makeTestServerApi = ({
  client,
}: {
  readonly client: typeof HttpClient.HttpClient.Service;
}): CaaraAgentApi => {
  const execute = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
    const response = yield* client.execute(request);
    return { status: response.status, body: yield* response.json };
  });
  return {
    post: ({ url, body }) =>
      HttpClientRequest.bodyJson(HttpClientRequest.post(new URL(url).pathname), body).pipe(
        Effect.flatMap(execute),
        Effect.orDie,
      ),
    get: (url) =>
      execute(HttpClientRequest.get(`${new URL(url).pathname}${new URL(url).search}`)).pipe(
        Effect.orDie,
      ),
  };
};

/** Builds portable HTTP routes backed by a real Antigravity driver and fake process boundary. */
const portableAgyLayer = ({
  fixture,
  fakeMode,
}: {
  readonly fixture: PortableAgyFixture;
  readonly fakeMode: string;
}) => {
  const routes = portableAgentRoutesLayerFromTurns({ turnsLayer: portableAgentTurnsLive });
  const server = Layer.effectDiscard(
    Effect.gen(function* () {
      const app = yield* HttpRouter.toHttpEffect(routes);
      yield* HttpServer.serveEffect(app);
    }),
  );
  return server.pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(sessionDirectoryBunTestLayer({ stateDir: fixture.stateDir })),
    Layer.provideMerge(antigravityCliDriverLayer),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(turnConcurrencyLive),
    Layer.provideMerge(Layer.succeed(RelayLogger, { log: () => Effect.void })),
    Layer.provideMerge(Layer.succeed(CaaraSettings, defaultCaaraSettingsValue)),
    Layer.provideMerge(
      Layer.succeed(AntigravityCliSettings, {
        command: fixture.executable,
        homeDir: fixture.homeDir,
        environment: {
          AGY_FAKE_INVOCATION_LOG: fixture.invocationLog,
          AGY_FAKE_MODE: fakeMode,
        },
      }),
    ),
  );
};

/** Starts one Antigravity turn through CLI adaptation and the real portable HTTP router. */
const startAgyTurn = ({
  api,
  prompt,
  sessionId,
}: {
  readonly api: CaaraAgentApi;
  readonly prompt: string;
  readonly sessionId?: string;
}) =>
  runCaaraAgentStart({
    args: ["--host", "127.0.0.1", "--port", "8787"],
    prompt,
    target: "agy/gemini-3.5-flash",
    cwd: projectRoot,
    driverOptions: { effort: "high", activity: "on", reasoning: "on" },
    sessionId,
    api,
  });

/** Runs first-turn and resume assertions against a provided portable server. */
const proveFirstAndResume = Effect.fnUntraced(function* (fixture: PortableAgyFixture) {
  const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
  const first = yield* startAgyTurn({ api, prompt: "first portable agy prompt" });
  const firstWait = yield* runCaaraAgentWait({
    args: [],
    turnId: first.turnId,
    timeoutMillis: 250,
    api,
  });
  const firstViewer = yield* HttpClient.execute(
    HttpClientRequest.get(new URL(first.observationUrl).pathname),
  ).pipe(Effect.flatMap((response) => response.text));
  const resumed = yield* startAgyTurn({
    api,
    prompt: "resumed portable agy prompt",
    sessionId: first.sessionId,
  });
  const resumedWait = yield* runCaaraAgentWait({
    args: [],
    turnId: resumed.turnId,
    timeoutMillis: 250,
    api,
  });
  const invocations = yield* readInvocations({ fixture });

  assert.deepStrictEqual(firstWait, {
    schemaVersion: 1,
    status: "completed",
    finalAnswer: fakeAgyFixture.finalAnswer,
  });
  assert.deepStrictEqual(resumedWait, {
    schemaVersion: 1,
    status: "completed",
    finalAnswer: fakeAgyFixture.resumedAnswer,
  });
  assert.match(firstViewer, new RegExp(fakeAgyFixture.reasoningText, "u"));
  assert.match(firstViewer, /Listing `src`/u);
  assert.strictEqual(invocations.length, 2);
  assert.strictEqual(invocations[0]?.cwd, projectRoot);
  assert.strictEqual(
    argumentValue({ args: invocations[0]?.args ?? [], name: "--model" }),
    "Gemini 3.5 Flash (High)",
  );
  assert.strictEqual(
    argumentValue({ args: invocations[0]?.args ?? [], name: "--print-timeout" }),
    "7200s",
  );
  assert.ok(invocations[0]?.args.includes("--sandbox"));
  assert.strictEqual(
    argumentValue({ args: invocations[1]?.args ?? [], name: "--conversation" }),
    fakeAgyFixture.conversationId,
  );
});

/** Runs overlap rejection and conservative cancellation assertions against a provided server. */
const proveConcurrencyAndCancellation = Effect.fnUntraced(function* () {
  const api = makeTestServerApi({ client: yield* HttpClient.HttpClient });
  const seed = yield* startAgyTurn({ api, prompt: "seed portable agy session" });
  const seedWait = yield* runCaaraAgentWait({
    args: [],
    turnId: seed.turnId,
    timeoutMillis: 250,
    api,
  });
  assert.strictEqual(seedWait.status, "completed");
  const started = yield* startAgyTurn({
    api,
    prompt: "long resumed portable agy prompt",
    sessionId: seed.sessionId,
  });
  const viewerPath = new URL(started.observationUrl).pathname;
  yield* HttpClient.execute(HttpClientRequest.get(viewerPath)).pipe(
    Effect.flatMap((response) => response.text),
    Effect.filterOrFail((html) => html.includes("Listing `src`")),
    Effect.retry(Schedule.both(Schedule.spaced("10 millis"), Schedule.recurs(50))),
  );
  const concurrent = yield* api.post({
    url: "http://127.0.0.1:8787/agent/turns",
    body: {
      prompt: "must reject concurrent resume",
      target: "agy/gemini-3.5-flash",
      cwd: projectRoot,
      driverOptions: {},
      sessionId: started.sessionId,
    },
  });
  const cancelled = yield* runCaaraAgentCancel({ args: [], turnId: started.turnId, api });
  const viewer = yield* HttpClient.execute(HttpClientRequest.get(viewerPath)).pipe(
    Effect.flatMap((response) => response.text),
  );

  assert.strictEqual(concurrent.status, 409);
  assert.deepStrictEqual(cancelled, {
    schemaVersion: 1,
    status: "cancelled",
    outcome: "Terminated",
    sessionReusable: false,
  });
  assert.match(viewer, /Status: cancelled/u);
  assert.match(viewer, /Session reusable: false/u);
  assert.match(viewer, /Listing `src`/u);
});

describe("Antigravity portable delegation", () => {
  it.live("proves CLI, HTTP, resume, viewer-only activity, and process options", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const layer = portableAgyLayer({ fixture, fakeMode: "portable-success" });
      yield* proveFirstAndResume(fixture).pipe(Effect.provide(layer));
    }),
  );

  it.live("rejects same-session concurrency and terminates a transcript-mutated cancellation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const layer = portableAgyLayer({ fixture, fakeMode: "portable-cancel-resume" });
      yield* proveConcurrencyAndCancellation().pipe(Effect.provide(layer));
    }),
  );
});
