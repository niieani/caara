#!/usr/bin/env bun

import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { HttpServer } from "effect/unstable/http";

import { caaraAgentDriverLive } from "./claudeAgentSdkDriver/driver.ts";
import { inputLoggerLive } from "./mockResponsesProvider/inputLogger.ts";
import { relayLoggerLive } from "./mockResponsesProvider/relayLogger.ts";
import { requestDiagnosticsLoggerLive } from "./mockResponsesProvider/requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./mockResponsesProvider/server.ts";
import { sessionDirectoryFromEnvironmentLive } from "./mockResponsesProvider/sessionDirectoryPlatform.ts";
import { turnConcurrencyLive } from "./mockResponsesProvider/turnConcurrency.ts";

/** Default TCP port for the local mock Responses provider. */
export const defaultMockResponsesPort = 8787;

/** Live session directory layer with Bun platform services supplied at the app edge. */
const sessionDirectoryLayer = sessionDirectoryFromEnvironmentLive().pipe(
  Layer.provide(BunServices.layer),
);

/** Live application layer for the local mock Responses provider. */
export const mainLayer = mockResponsesServerLayer.pipe(
  Layer.provideMerge(inputLoggerLive),
  Layer.provideMerge(relayLoggerLive),
  Layer.provideMerge(requestDiagnosticsLoggerLive),
  Layer.provideMerge(sessionDirectoryLayer),
  Layer.provideMerge(turnConcurrencyLive),
  Layer.provideMerge(caaraAgentDriverLive),
  Layer.provideMerge(
    HttpServer.withLogAddress(BunHttpServer.layer({ port: defaultMockResponsesPort })),
  ),
);

BunRuntime.runMain(Layer.launch(mainLayer));
