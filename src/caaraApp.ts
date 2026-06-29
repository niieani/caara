import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";

import {
  CaaraSettings,
  caaraSettingsLayerFromArgs,
  caaraSettingsLayerFromValue,
  type CaaraSettingsValue,
} from "./caaraSettings.ts";
import { caaraAgentDriverLive } from "./claudeAgentSdkDriver/driver.ts";
import { inputLoggerLive } from "./mockResponsesProvider/inputLogger.ts";
import { relayLoggerLive } from "./mockResponsesProvider/relayLogger.ts";
import { requestDiagnosticsLoggerLive } from "./mockResponsesProvider/requestDiagnosticsLogger.ts";
import { mockResponsesServerLayer } from "./mockResponsesProvider/server.ts";
import { sessionDirectoryFromEnvironmentLive } from "./mockResponsesProvider/sessionDirectoryPlatform.ts";
import { turnConcurrencyLive } from "./mockResponsesProvider/turnConcurrency.ts";

/** Bun idle timeout for quiet long-running SSE responses; zero disables it. */
export const mockResponsesIdleTimeoutSeconds = 0;

/** Live session directory layer with Bun platform services supplied at the app edge. */
const sessionDirectoryLayer = sessionDirectoryFromEnvironmentLive().pipe(
  Layer.provide(BunServices.layer),
);

/** Builds Bun HTTP server options from runtime-wide Caara settings. */
export const httpServerOptionsFromCaaraSettings = ({
  settings,
}: {
  readonly settings: CaaraSettingsValue;
}) => ({
  hostname: settings.host,
  port: settings.port,
  idleTimeout: mockResponsesIdleTimeoutSeconds,
});

/** Live Bun HTTP server layer configured by runtime-wide Caara settings. */
const caaraHttpServerLayer = Layer.unwrap(
  Effect.map(CaaraSettings, (settings) =>
    HttpServer.withLogAddress(
      BunHttpServer.layer(httpServerOptionsFromCaaraSettings({ settings })),
    ),
  ),
);

/** Builds the live application layer without the Caara settings provider. */
const mainLayerWithoutSettings = mockResponsesServerLayer.pipe(
  Layer.provideMerge(inputLoggerLive),
  Layer.provideMerge(relayLoggerLive),
  Layer.provideMerge(requestDiagnosticsLoggerLive),
  Layer.provideMerge(sessionDirectoryLayer),
  Layer.provideMerge(turnConcurrencyLive),
  Layer.provideMerge(caaraAgentDriverLive),
  Layer.provideMerge(caaraHttpServerLayer),
);

/** Builds the live application layer for a concrete settings value. */
export const mainLayerFromSettings = ({ settings }: { readonly settings: CaaraSettingsValue }) =>
  mainLayerWithoutSettings.pipe(Layer.provideMerge(caaraSettingsLayerFromValue({ settings })));

/** Builds the live application layer for already-split startup args. */
export const mainLayerFromArgs = ({ args }: { readonly args: readonly string[] }) =>
  mainLayerWithoutSettings.pipe(Layer.provideMerge(caaraSettingsLayerFromArgs({ args })));

/** Live application layer for the local mock Responses provider. */
export const mainLayer = mainLayerFromArgs({ args: process.argv.slice(2) });
