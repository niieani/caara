import { randomUUID } from "node:crypto";
import path from "node:path";

import { BunHttpServer } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { diagnosticAgentDriverRegistryLive } from "./diagnosticDriver.ts";
import { InputLogger } from "./inputLogger.ts";
import { RelayLogger } from "./relayLogger.ts";
import { RequestDiagnosticsLogger } from "./requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./server.ts";
import { sessionDirectoryBunTestLayer } from "./sessionDirectoryBunTestLayer.ts";
import { turnConcurrencyLive } from "./turnConcurrency.ts";

/** Stable workspace root used for health endpoint test state. */
const projectRoot = process.cwd();

/** Full provider layer used to prove health is served by the live router. */
const healthTestLayer = mockResponsesServerLayer.pipe(
  Layer.provideMerge(BunHttpServer.layerTest),
  Layer.provideMerge(Layer.succeed(InputLogger, { logInput: () => Effect.void })),
  Layer.provideMerge(Layer.succeed(RelayLogger, { log: () => Effect.void })),
  Layer.provideMerge(Layer.succeed(RequestDiagnosticsLogger, { logRequest: () => Effect.void })),
  Layer.provideMerge(
    sessionDirectoryBunTestLayer({
      stateDir: path.join(projectRoot, "temp.local", `health-${randomUUID()}`),
    }),
  ),
  Layer.provideMerge(turnConcurrencyLive),
  Layer.provideMerge(diagnosticAgentDriverRegistryLive),
);

describe("Caara health endpoint", () => {
  it.effect("returns shallow service health without invoking agent state", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(HttpClientRequest.get("/health"));
      const body = yield* response.json;

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(body, {
        status: "ok",
        service: "caara",
      });
    }).pipe(Effect.provide(healthTestLayer)),
  );
});
