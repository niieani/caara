import fs from "node:fs/promises";
import path from "node:path";

import { Context, Effect, Layer, Option, Schema } from "effect";

import type { CaaraSettingsEnvironment, CaaraSettingsValue } from "./caaraSettings.ts";

/** Environment values used to resolve Caara app log paths. */
export interface CaaraLogEnvironment extends CaaraSettingsEnvironment {
  readonly XDG_STATE_HOME?: string | undefined;
}

/** Fixed app-owned log rotation policy. */
export interface CaaraLogRotationPolicy {
  readonly maxBytes: number;
  readonly retainedFiles: number;
}

/** Filesystem/logging failure raised by Caara app-owned logging. */
export class CaaraLogError extends Schema.TaggedErrorClass<CaaraLogError>()("CaaraLogError", {
  message: Schema.String,
}) {}

/** Service that appends already-encoded JSONL log lines to Caara's app log. */
export class CaaraAppLogWriter extends Context.Service<
  CaaraAppLogWriter,
  {
    readonly writeLine: (line: string) => ReturnType<typeof appendCaaraLogLine>;
  }
>()("@caara/CaaraAppLogWriter") {}

/** First-cut Caara app log rotation policy: 10 MiB, 3 retained rotated files. */
export const defaultCaaraLogRotationPolicy: CaaraLogRotationPolicy = {
  maxBytes: 10 * 1024 * 1024,
  retainedFiles: 3,
};

/** Builds one typed Caara log failure from a message. */
const caaraLogError = (message: string): CaaraLogError => new CaaraLogError({ message });

/** Converts unknown filesystem failures into typed Caara log failures. */
const caaraLogErrorFromCause = (cause: unknown): CaaraLogError => caaraLogError(String(cause));

/** Resolves XDG state home from explicit XDG_STATE_HOME or HOME. */
const stateHomeFromEnvironment = ({
  env,
}: {
  readonly env: CaaraLogEnvironment;
}): string | undefined =>
  env.XDG_STATE_HOME ??
  [env.HOME]
    .filter((home): home is string => home !== undefined)
    .map((home) => path.join(home, ".local", "state"))
    .at(0);

/** Resolves the default Caara app-owned JSONL log file path. */
export const defaultCaaraLogFile = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: CaaraLogEnvironment;
}) {
  return yield* Option.match(Option.fromUndefinedOr(stateHomeFromEnvironment({ env })), {
    onNone: () =>
      Effect.fail(caaraLogError("Unable to resolve Caara log path: set XDG_STATE_HOME or HOME.")),
    onSome: (stateHome) => Effect.succeed(path.join(stateHome, "caara", "logs", "caara.log")),
  });
});

/** Resolves the configured or default Caara app-owned JSONL log file path. */
export const resolveCaaraLogFile = Effect.fnUntraced(function* ({
  settings,
  env,
}: {
  readonly settings: CaaraSettingsValue;
  readonly env: CaaraLogEnvironment;
}) {
  return yield* Option.match(Option.fromUndefinedOr(settings.logFile), {
    onNone: () => defaultCaaraLogFile({ env }),
    onSome: Effect.succeed,
  });
});

/** Returns one rotated log file path by index. */
const rotatedLogFilePath = ({
  logFile,
  index,
}: {
  readonly logFile: string;
  readonly index: number;
}): string => `${logFile}.${index}`;

/** Creates the parent directory for one app-owned log file. */
const makeLogDirectory = Effect.fnUntraced(function* ({ logFile }: { readonly logFile: string }) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(logFile), { recursive: true }),
    catch: caaraLogErrorFromCause,
  });
});

/** Returns the current size for an existing file, or undefined when it is absent. */
const existingFileSize = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  const file = Bun.file(filePath);
  const exists = yield* Effect.tryPromise({
    try: () => file.exists(),
    catch: caaraLogErrorFromCause,
  });
  return Option.getOrUndefined(Option.fromUndefinedOr(file.size).pipe(Option.filter(() => exists)));
});

/** Deletes one file path if it exists. */
const removeFileIfPresent = Effect.fnUntraced(function* ({
  filePath,
}: {
  readonly filePath: string;
}) {
  yield* Effect.tryPromise({
    try: () => fs.rm(filePath, { force: true }),
    catch: caaraLogErrorFromCause,
  });
});

/** Renames one file when the source exists. */
const renameFileIfPresent = Effect.fnUntraced(function* ({
  from,
  to,
}: {
  readonly from: string;
  readonly to: string;
}) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(from).exists(),
    catch: caaraLogErrorFromCause,
  });
  return yield* Option.match(Option.fromUndefinedOr([from].filter(() => exists).at(0)), {
    onNone: () => Effect.void,
    onSome: (sourcePath) =>
      Effect.tryPromise({
        try: () => fs.rename(sourcePath, to),
        catch: caaraLogErrorFromCause,
      }),
  });
});

/** Returns rotated file indexes that must be shifted before rotating the active log. */
const retainedRotationIndexes = ({
  retainedFiles,
}: {
  readonly retainedFiles: number;
}): readonly number[] =>
  Array.from(
    { length: Math.max(retainedFiles - 1, 0) },
    (_, index) => retainedFiles - 1 - index,
  ).filter((index) => index > 0);

/** Rotates one app-owned log file according to the fixed Caara retention policy. */
export const rotateCaaraLogFile = Effect.fnUntraced(function* ({
  logFile,
  policy = defaultCaaraLogRotationPolicy,
}: {
  readonly logFile: string;
  readonly policy?: CaaraLogRotationPolicy;
}) {
  yield* makeLogDirectory({ logFile });
  const size = yield* existingFileSize({ filePath: logFile });
  return yield* Option.match(
    Option.fromUndefinedOr(size).pipe(Option.filter((fileSize) => fileSize >= policy.maxBytes)),
    {
      onNone: () => Effect.void,
      onSome: () =>
        Effect.gen(function* () {
          yield* removeFileIfPresent({
            filePath: rotatedLogFilePath({ logFile, index: policy.retainedFiles }),
          });
          yield* Effect.forEach(
            retainedRotationIndexes({ retainedFiles: policy.retainedFiles }),
            (index) =>
              renameFileIfPresent({
                from: rotatedLogFilePath({ logFile, index }),
                to: rotatedLogFilePath({ logFile, index: index + 1 }),
              }),
            { discard: true },
          );
          yield* renameFileIfPresent({
            from: logFile,
            to: rotatedLogFilePath({ logFile, index: 1 }),
          });
        }),
    },
  );
});

/** Appends one encoded JSONL line to the Caara app-owned log file. */
export const appendCaaraLogLine = Effect.fnUntraced(function* ({
  logFile,
  line,
}: {
  readonly logFile: string;
  readonly line: string;
}) {
  yield* makeLogDirectory({ logFile });
  yield* Effect.tryPromise({
    try: () => fs.appendFile(logFile, `${line}\n`, "utf8"),
    catch: caaraLogErrorFromCause,
  });
});

/** Builds a Caara app log writer layer for a concrete log file. */
export const caaraAppLogWriterLayerFromFile = ({ logFile }: { readonly logFile: string }) =>
  Layer.succeed(CaaraAppLogWriter, {
    writeLine: (line) => appendCaaraLogLine({ logFile, line }),
  });
