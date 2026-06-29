import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { HttpServer } from "effect/unstable/http";

import {
  caaraAppLogWriterLayerFromFile,
  resolveCaaraLogFile,
  rotateCaaraLogFile,
} from "./caaraLogging.ts";
import {
  CaaraSettings,
  caaraSettingsLayerFromArgs,
  caaraSettingsLayerFromValue,
  type CaaraSettingsValue,
} from "./caaraSettings.ts";
import { caaraAgentDriverLive } from "./claudeAgentSdkDriver/driver.ts";
import { inputLoggerWithAppLogLive } from "./mockResponsesProvider/inputLogger.ts";
import { relayLoggerWithAppLogLive } from "./mockResponsesProvider/relayLogger.ts";
import { requestDiagnosticsLoggerWithAppLogLive } from "./mockResponsesProvider/requestDiagnosticsLogger.ts";
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

/** Builds the app-owned logging layer for an already-rotated target log file. */
const caaraAppLoggingLayerFromFile = ({ logFile }: { readonly logFile: string }) => {
  const appLogWriterLayer = caaraAppLogWriterLayerFromFile({ logFile });
  const providerLoggerLayer = Layer.mergeAll(
    inputLoggerWithAppLogLive,
    relayLoggerWithAppLogLive,
    requestDiagnosticsLoggerWithAppLogLive,
  ).pipe(Layer.provideMerge(appLogWriterLayer));
  const effectLoggerLayer = Logger.layer([
    Logger.defaultLogger,
    Logger.formatJson.pipe(Logger.toFile(logFile, { batchWindow: "0 millis" })),
  ]).pipe(Layer.provide(BunServices.layer));

  return Layer.mergeAll(providerLoggerLayer, effectLoggerLayer);
};

/** Builds the live application layer before app-owned logging is attached. */
const runtimeLayerWithoutLogging = mockResponsesServerLayer.pipe(
  Layer.provideMerge(sessionDirectoryLayer),
  Layer.provideMerge(turnConcurrencyLive),
  Layer.provideMerge(caaraAgentDriverLive),
  Layer.provideMerge(caaraHttpServerLayer),
);

/** Builds the live application layer without the Caara settings provider. */
const mainLayerWithoutSettings = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* CaaraSettings;
    const logFile = yield* resolveCaaraLogFile({ settings, env: process.env });
    yield* rotateCaaraLogFile({ logFile });

    return runtimeLayerWithoutLogging.pipe(
      Layer.provideMerge(caaraAppLoggingLayerFromFile({ logFile })),
    );
  }),
);

/** Builds the live application layer for a concrete settings value. */
export const mainLayerFromSettings = ({ settings }: { readonly settings: CaaraSettingsValue }) =>
  mainLayerWithoutSettings.pipe(Layer.provideMerge(caaraSettingsLayerFromValue({ settings })));

/** Builds the live application layer for already-split startup args. */
export const mainLayerFromArgs = ({ args }: { readonly args: readonly string[] }) =>
  mainLayerWithoutSettings.pipe(Layer.provideMerge(caaraSettingsLayerFromArgs({ args })));

/** Live application layer for the local mock Responses provider. */
export const mainLayer = mainLayerFromArgs({ args: process.argv.slice(2) });
