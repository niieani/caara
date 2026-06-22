#!/usr/bin/env bun

import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";
import { HttpServer } from "effect/unstable/http";

import { inputLoggerLive } from "./mockResponsesProvider/inputLogger.ts";
import { requestDiagnosticsLoggerLive } from "./mockResponsesProvider/requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./mockResponsesProvider/server.ts";

/** Default TCP port for the local mock Responses provider. */
export const defaultMockResponsesPort = 8787;

/** Live application layer for the local mock Responses provider. */
export const mainLayer = mockResponsesServerLayer.pipe(
  Layer.provideMerge(inputLoggerLive),
  Layer.provideMerge(requestDiagnosticsLoggerLive),
  Layer.provideMerge(
    HttpServer.withLogAddress(BunHttpServer.layer({ port: defaultMockResponsesPort })),
  ),
);

BunRuntime.runMain(Layer.launch(mainLayer));
