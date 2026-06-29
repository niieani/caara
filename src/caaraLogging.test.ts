import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import {
  caaraAppLogWriterLayerFromFile,
  defaultCaaraLogRotationPolicy,
  resolveCaaraLogFile,
  rotateCaaraLogFile,
} from "./caaraLogging.ts";
import { defaultCaaraSettingsValue } from "./caaraSettings.ts";
import { InputLogger, inputLoggerWithAppLogLive } from "./mockResponsesProvider/inputLogger.ts";
import { RelayLogger, relayLoggerWithAppLogLive } from "./mockResponsesProvider/relayLogger.ts";
import {
  RequestDiagnosticsLogger,
  requestDiagnosticsLoggerWithAppLogLive,
} from "./mockResponsesProvider/requestDiagnosticsLogger.ts";

/** Temporary root used by Caara logging tests. */
const testRoot = (): string => path.join(process.cwd(), "temp.local", `caara-logs-${randomUUID()}`);

/** Writes one UTF-8 file, creating its parent directory first. */
const writeFile = Effect.fnUntraced(function* ({
  filePath,
  content,
}: {
  readonly filePath: string;
  readonly content: string;
}) {
  yield* Effect.tryPromise(() => fs.mkdir(path.dirname(filePath), { recursive: true }));
  yield* Effect.tryPromise(() => fs.writeFile(filePath, content, "utf8"));
});

/** Reads one UTF-8 file from disk. */
const readFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
});

/** Returns whether one file currently exists. */
const fileExists = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => Bun.file(filePath).exists());
});

/** Builds the provider logger test layer for one app-owned log path. */
const providerLoggersAppLogLayer = ({ logFile }: { readonly logFile: string }) =>
  Layer.provideMerge(
    Layer.mergeAll(
      inputLoggerWithAppLogLive,
      relayLoggerWithAppLogLive,
      requestDiagnosticsLoggerWithAppLogLive,
    ),
    caaraAppLogWriterLayerFromFile({ logFile }),
  );

/** Asserts that provider loggers write existing JSON log lines to the app log. */
const assertProviderLoggersWriteToAppLog = Effect.fnUntraced(function* ({
  logFile,
}: {
  readonly logFile: string;
}) {
  const inputLogger = yield* InputLogger;
  const relayLogger = yield* RelayLogger;
  const diagnosticsLogger = yield* RequestDiagnosticsLogger;

  yield* inputLogger.logInput({ prompt: "hello" });
  yield* relayLogger.log({
    _tag: "TurnCompleted",
    threadId: "thread-id",
    turnId: "turn-id",
  });
  yield* diagnosticsLogger.logRequest({
    method: "POST",
    url: "/v1/responses",
    headers: {},
    body: { input: "hello" },
    cwdCandidates: ["/repo"],
  });
  const logLines = (yield* readFile({ filePath: logFile })).trim().split("\n");
  const decoded = yield* Effect.forEach(logLines, (logLine) =>
    Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(logLine),
  );

  assert.deepStrictEqual(decoded, [
    { prompt: "hello" },
    {
      event: "caara.relay",
      _tag: "TurnCompleted",
      threadId: "thread-id",
      turnId: "turn-id",
    },
    {
      event: "caara.responses.request",
      method: "POST",
      url: "/v1/responses",
      headers: {},
      body: { input: "hello" },
      cwdCandidates: ["/repo"],
    },
  ]);
});

describe("Caara app logging", () => {
  it.effect("resolves configured and default XDG log file paths", () =>
    Effect.gen(function* () {
      const explicitLogFile = yield* resolveCaaraLogFile({
        settings: {
          ...defaultCaaraSettingsValue,
          logFile: "/tmp/caara-explicit.log",
        },
        env: {
          HOME: "/Users/caara",
          XDG_STATE_HOME: "/state",
        },
      });
      const defaultLogFile = yield* resolveCaaraLogFile({
        settings: defaultCaaraSettingsValue,
        env: {
          HOME: "/Users/caara",
          XDG_STATE_HOME: "/state",
        },
      });

      assert.strictEqual(explicitLogFile, "/tmp/caara-explicit.log");
      assert.strictEqual(defaultLogFile, "/state/caara/logs/caara.log");
    }),
  );

  it.effect("does not rotate files below the size threshold", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const logFile = path.join(root, "caara.log");
      yield* writeFile({ filePath: logFile, content: "small" });

      yield* rotateCaaraLogFile({
        logFile,
        policy: {
          ...defaultCaaraLogRotationPolicy,
          maxBytes: 10,
        },
      });

      assert.strictEqual(yield* readFile({ filePath: logFile }), "small");
      assert.strictEqual(yield* fileExists({ filePath: `${logFile}.1` }), false);
    }),
  );

  it.effect("rotates files above the size threshold and retains the newest rotated files", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const logFile = path.join(root, "caara.log");
      yield* writeFile({ filePath: logFile, content: "current" });
      yield* writeFile({ filePath: `${logFile}.1`, content: "older-1" });
      yield* writeFile({ filePath: `${logFile}.2`, content: "older-2" });
      yield* writeFile({ filePath: `${logFile}.3`, content: "older-3" });

      yield* rotateCaaraLogFile({
        logFile,
        policy: {
          ...defaultCaaraLogRotationPolicy,
          maxBytes: 5,
        },
      });

      assert.strictEqual(yield* fileExists({ filePath: logFile }), false);
      assert.strictEqual(yield* readFile({ filePath: `${logFile}.1` }), "current");
      assert.strictEqual(yield* readFile({ filePath: `${logFile}.2` }), "older-1");
      assert.strictEqual(yield* readFile({ filePath: `${logFile}.3` }), "older-2");
    }),
  );

  it.effect("writes existing provider log lines to the app-owned JSONL log", () =>
    Effect.gen(function* () {
      const logFile = path.join(testRoot(), "caara.log");
      yield* assertProviderLoggersWriteToAppLog({ logFile }).pipe(
        Effect.provide(providerLoggersAppLogLayer({ logFile })),
      );
    }),
  );
});
