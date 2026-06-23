#!/usr/bin/env bun

import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { HttpServer } from "effect/unstable/http";

import { claudeAgentSdkDriverLive } from "./claudeAgentSdkDriver/driver.ts";
import { inputLoggerLive } from "./mockResponsesProvider/inputLogger.ts";
import { relayLoggerLive } from "./mockResponsesProvider/relayLogger.ts";
import { requestDiagnosticsLoggerLive } from "./mockResponsesProvider/requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./mockResponsesProvider/server.ts";
import { sessionDirectoryFromEnvironmentLive } from "./mockResponsesProvider/sessionDirectory.ts";
import { turnConcurrencyLive } from "./mockResponsesProvider/turnConcurrency.ts";

/** Default TCP port for the local mock Responses provider. */
export const defaultMockResponsesPort = 8787;

/** Live application layer for the local mock Responses provider. */
export const mainLayer = mockResponsesServerLayer.pipe(
  Layer.provideMerge(inputLoggerLive),
  Layer.provideMerge(relayLoggerLive),
  Layer.provideMerge(requestDiagnosticsLoggerLive),
  Layer.provideMerge(sessionDirectoryFromEnvironmentLive),
  Layer.provideMerge(turnConcurrencyLive),
  Layer.provideMerge(claudeAgentSdkDriverLive),
  Layer.provideMerge(
    HttpServer.withLogAddress(BunHttpServer.layer({ port: defaultMockResponsesPort })),
  ),
);

BunRuntime.runMain(Layer.launch(mainLayer));
