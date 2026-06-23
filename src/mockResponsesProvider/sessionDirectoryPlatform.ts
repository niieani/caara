import { Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  CaaraSessionBinding,
  type SessionBindingKey,
  SessionDirectory,
  SessionDirectoryError,
  type SessionDirectoryDelete,
  type SessionDirectoryGet,
  type SessionDirectorySave,
} from "./sessionDirectory.ts";

/** Configuration failure while resolving the Caara session state directory. */
export class SessionDirectoryConfigError extends Schema.TaggedErrorClass<SessionDirectoryConfigError>()(
  "SessionDirectoryConfigError",
  {
    message: Schema.String,
  },
) {}

/** Filesystem path options for one session binding file. */
export interface SessionBindingFilePathOptions {
  readonly stateDir: string;
  readonly externalAgentKind: string;
  readonly driverInstanceId: string;
  readonly codexThreadId: string;
}

/** Concrete implementation shape provided for the SessionDirectory service. */
interface SessionDirectoryImplementation {
  readonly get: SessionDirectoryGet;
  readonly save: SessionDirectorySave;
  readonly delete: SessionDirectoryDelete;
}

/** Environment shape used to resolve the live Caara state directory. */
export type SessionDirectoryEnvironment = Readonly<Record<string, string | undefined>>;

/** Encodes one session key component into a safe filesystem segment. */
const encodeSessionPathSegment = (segment: string): string => encodeURIComponent(segment);

/** Joins stable session binding path segments for direct test inspection. */
const joinSessionBindingPath = (stateDir: string, segments: readonly string[]): string =>
  [stateDir.replace(/\/+$/u, ""), ...segments].join("/");

/** Returns the durable binding file path for one session key. */
export const sessionBindingFilePath = ({
  stateDir,
  externalAgentKind,
  driverInstanceId,
  codexThreadId,
}: SessionBindingFilePathOptions): string =>
  joinSessionBindingPath(stateDir, [
    "sessions",
    encodeSessionPathSegment(externalAgentKind),
    encodeSessionPathSegment(driverInstanceId),
    `${encodeSessionPathSegment(codexThreadId)}.json`,
  ]);

/** Returns the durable binding file path using the injected platform path service. */
const sessionBindingFilePathFromPath = ({
  pathService,
  stateDir,
  externalAgentKind,
  driverInstanceId,
  codexThreadId,
}: SessionBindingFilePathOptions & { readonly pathService: Path.Path }): string =>
  pathService.join(
    stateDir,
    "sessions",
    encodeSessionPathSegment(externalAgentKind),
    encodeSessionPathSegment(driverInstanceId),
    `${encodeSessionPathSegment(codexThreadId)}.json`,
  );

/** Converts unknown filesystem failures into a typed session directory error. */
const sessionDirectoryError = (cause: unknown): SessionDirectoryError =>
  new SessionDirectoryError({ message: String(cause) });

/** Builds a typed state-directory configuration failure. */
const sessionDirectoryConfigError = (message: string): SessionDirectoryConfigError =>
  new SessionDirectoryConfigError({ message });

/** Decodes one persisted binding JSON string. */
const decodeBindingJson = Effect.fnUntraced(function* (content: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CaaraSessionBinding))(
    content,
  ).pipe(Effect.mapError((cause) => sessionDirectoryError(cause)));
});

/** Reads a binding file when it exists, returning none for a missing file. */
const readBindingFile = Effect.fnUntraced(function* ({
  fileSystem,
  filePath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly filePath: string;
}) {
  const exists = yield* fileSystem.exists(filePath).pipe(Effect.mapError(sessionDirectoryError));
  const readableFile = Option.fromUndefinedOr([filePath].filter(() => exists).at(0));

  return yield* Option.match(readableFile, {
    onNone: () => Effect.succeed(Option.none<CaaraSessionBinding>()),
    onSome: (pathToRead) =>
      fileSystem
        .readFileString(pathToRead, "utf8")
        .pipe(
          Effect.mapError(sessionDirectoryError),
          Effect.flatMap(decodeBindingJson),
          Effect.map(Option.some),
        ),
  });
});

/** Writes a binding file, creating parent directories first. */
const writeBindingFile = Effect.fnUntraced(function* ({
  fileSystem,
  pathService,
  filePath,
  binding,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly filePath: string;
  readonly binding: CaaraSessionBinding;
}) {
  yield* fileSystem
    .makeDirectory(pathService.dirname(filePath), { recursive: true })
    .pipe(Effect.mapError(sessionDirectoryError));
  const encodedBinding = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(binding).pipe(
    Effect.mapError((cause) => sessionDirectoryError(cause)),
  );
  yield* fileSystem
    .writeFileString(filePath, encodedBinding)
    .pipe(Effect.mapError(sessionDirectoryError));
});

/** Deletes a binding file when cancellation makes its external session unusable. */
const deleteBindingFile = Effect.fnUntraced(function* ({
  fileSystem,
  filePath,
}: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly filePath: string;
}) {
  yield* fileSystem.remove(filePath, { force: true }).pipe(Effect.mapError(sessionDirectoryError));
});

/** Builds the concrete session directory implementation from injected platform services. */
const makeSessionDirectory = ({
  stateDir,
  fileSystem,
  pathService,
}: {
  readonly stateDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
}): SessionDirectoryImplementation => {
  const bindingPath = (key: SessionBindingKey): string =>
    sessionBindingFilePathFromPath({ stateDir, pathService, ...key });

  return {
    get: Effect.fnUntraced(function* (key: SessionBindingKey) {
      return yield* readBindingFile({ fileSystem, filePath: bindingPath(key) });
    }),
    save: Effect.fnUntraced(function* (binding: CaaraSessionBinding) {
      return yield* writeBindingFile({
        fileSystem,
        pathService,
        filePath: bindingPath(binding.bindingKey),
        binding,
      });
    }),
    delete: Effect.fnUntraced(function* (key: SessionBindingKey) {
      yield* deleteBindingFile({ fileSystem, filePath: bindingPath(key) });
    }),
  };
};

/** Builds a filesystem-backed session directory layer rooted at a Caara state directory. */
export const sessionDirectoryLive = ({ stateDir }: { readonly stateDir: string }) =>
  Layer.effect(
    SessionDirectory,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      return makeSessionDirectory({ stateDir, fileSystem, pathService });
    }),
  );

/** Resolves the default Caara user-state directory from explicit environment values. */
export const resolveCaaraStateDir = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: SessionDirectoryEnvironment;
}) {
  const pathService = yield* Path.Path;
  const xdgStateDir = [env.XDG_STATE_HOME]
    .filter((stateHome): stateHome is string => stateHome !== undefined)
    .map((stateHome) => pathService.join(stateHome, "caara"))
    .at(0);
  const homeStateDir = [env.HOME]
    .filter((home): home is string => home !== undefined)
    .map((home) => pathService.join(home, ".local", "state", "caara"))
    .at(0);
  const stateDir = [env.CAARA_STATE_DIR, xdgStateDir, homeStateDir]
    .filter((candidate): candidate is string => candidate !== undefined)
    .at(0);

  return yield* Option.match(Option.fromUndefinedOr(stateDir), {
    onNone: () =>
      Effect.fail(
        sessionDirectoryConfigError(
          "Unable to resolve Caara state directory: set CAARA_STATE_DIR, XDG_STATE_HOME, or HOME.",
        ),
      ),
    onSome: Effect.succeed,
  });
});

/** Live session directory layer resolved from the current process environment. */
export const sessionDirectoryFromEnvironmentLive = ({
  env = process.env,
}: {
  readonly env?: SessionDirectoryEnvironment;
} = {}) =>
  Layer.effect(
    SessionDirectory,
    Effect.gen(function* () {
      const stateDir = yield* resolveCaaraStateDir({ env });
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      return makeSessionDirectory({ stateDir, fileSystem, pathService });
    }),
  );
