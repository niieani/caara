import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Context, Effect, Layer, Option, Schema } from "effect";

import { AgentTarget, type CodexTurnContext } from "./codexTurnContext.ts";
import { InvalidResponsesRequest } from "./errors.ts";

/** Durable external session state stored by Caara for resumable drivers. */
export class DurableExternalSession extends Schema.TaggedClass<DurableExternalSession>()(
  "Durable",
  {
    externalSessionId: Schema.String,
  },
) {}

/** Ephemeral external session marker reserved for future non-durable drivers. */
export class EphemeralExternalSession extends Schema.TaggedClass<EphemeralExternalSession>()(
  "Ephemeral",
  {},
) {}

/** External session state persisted in a Caara session binding. */
export const ExternalSessionState = Schema.Union([
  DurableExternalSession,
  EphemeralExternalSession,
]);

/** External session state persisted in a Caara session binding. */
export type ExternalSessionState = typeof ExternalSessionState.Type;

/** Durable session binding record stored under the Caara user-state session directory. */
export class CaaraSessionBinding extends Schema.Class<CaaraSessionBinding>("CaaraSessionBinding")({
  codexThreadId: Schema.String,
  parentCodexSessionId: Schema.String,
  externalAgentKind: Schema.String,
  requestedModel: Schema.String,
  externalModelSpecifier: Schema.String,
  rawDriverOptions: Schema.Record(Schema.String, Schema.String),
  externalSession: ExternalSessionState,
  cwd: Schema.String,
  createdFromTurnId: Schema.String,
  lastTurnId: Schema.String,
}) {}

/** Filesystem operation failure while loading or storing Caara session bindings. */
export class SessionDirectoryError extends Schema.TaggedErrorClass<SessionDirectoryError>()(
  "SessionDirectoryError",
  {
    message: Schema.String,
  },
) {}

/** Prepared binding state for one turn before the selected driver runs. */
export interface PreparedSessionBinding {
  readonly binding: CaaraSessionBinding | undefined;
  readonly cwd: string;
  readonly previousTarget: AgentTarget | undefined;
}

/** Session directory service used to persist durable binding metadata. */
export class SessionDirectory extends Context.Service<
  SessionDirectory,
  {
    readonly get: (key: SessionBindingKey) => ReturnType<typeof getSessionBindingEffectShape>;
    readonly save: (
      binding: CaaraSessionBinding,
    ) => ReturnType<typeof saveSessionBindingEffectShape>;
  }
>()("@caara/SessionDirectory") {}

/** Stable key for one external-agent-kind and Codex-thread binding. */
export interface SessionBindingKey {
  readonly externalAgentKind: string;
  readonly codexThreadId: string;
}

/** Filesystem path options for one session binding file. */
export interface SessionBindingFilePathOptions extends SessionBindingKey {
  readonly stateDir: string;
}

/** Type-shape function for session binding lookup effects. */
export const getSessionBindingEffectShape = Effect.fnUntraced(function* (_key: SessionBindingKey) {
  const shapeFailure = Option.none<SessionDirectoryError>();
  yield* Option.match(shapeFailure, {
    onNone: () => Effect.void,
    onSome: (error) => error,
  });
  return Option.none<CaaraSessionBinding>();
});

/** Type-shape function for session binding write effects. */
export const saveSessionBindingEffectShape = Effect.fnUntraced(function* (
  _binding: CaaraSessionBinding,
) {
  const shapeFailure = Option.none<SessionDirectoryError>();
  yield* Option.match(shapeFailure, {
    onNone: () => Effect.void,
    onSome: (error) => error,
  });
});

/** Encodes one session key component into a safe filesystem segment. */
const encodeSessionPathSegment = (segment: string): string => encodeURIComponent(segment);

/** Returns the durable binding file path for one session key. */
export const sessionBindingFilePath = ({
  stateDir,
  externalAgentKind,
  codexThreadId,
}: SessionBindingFilePathOptions): string =>
  path.join(
    stateDir,
    "sessions",
    encodeSessionPathSegment(externalAgentKind),
    `${encodeSessionPathSegment(codexThreadId)}.json`,
  );

/** Converts unknown filesystem failures into a typed session directory error. */
const sessionDirectoryError = (cause: unknown): SessionDirectoryError =>
  new SessionDirectoryError({ message: String(cause) });

/** Decodes one persisted binding JSON string. */
const decodeBindingJson = Effect.fnUntraced(function* (content: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CaaraSessionBinding))(
    content,
  ).pipe(Effect.mapError((cause) => sessionDirectoryError(cause)));
});

/** Reads a binding file when it exists, returning none for a missing file. */
const readBindingFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(filePath).exists(),
    catch: sessionDirectoryError,
  });
  const readableFile = Option.fromUndefinedOr([filePath].filter(() => exists).at(0));

  return yield* Option.match(readableFile, {
    onNone: () => Effect.succeed(Option.none<CaaraSessionBinding>()),
    onSome: (pathToRead) =>
      Effect.tryPromise({
        try: () => fs.readFile(pathToRead, "utf8"),
        catch: sessionDirectoryError,
      }).pipe(Effect.flatMap(decodeBindingJson), Effect.map(Option.some)),
  });
});

/** Writes a binding file, creating parent directories first. */
const writeBindingFile = Effect.fnUntraced(function* ({
  filePath,
  binding,
}: {
  readonly filePath: string;
  readonly binding: CaaraSessionBinding;
}) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(filePath), { recursive: true }),
    catch: sessionDirectoryError,
  });
  const encodedBinding = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(binding).pipe(
    Effect.mapError((cause) => sessionDirectoryError(cause)),
  );
  yield* Effect.tryPromise({
    try: () => fs.writeFile(filePath, encodedBinding),
    catch: sessionDirectoryError,
  });
});

/** Builds a filesystem-backed session directory layer rooted at a Caara state directory. */
export const sessionDirectoryLive = ({ stateDir }: { readonly stateDir: string }) =>
  Layer.succeed(SessionDirectory, {
    get: Effect.fnUntraced(function* (key: SessionBindingKey) {
      return yield* readBindingFile({ filePath: sessionBindingFilePath({ stateDir, ...key }) });
    }),
    save: Effect.fnUntraced(function* (binding: CaaraSessionBinding) {
      return yield* writeBindingFile({
        filePath: sessionBindingFilePath({
          stateDir,
          externalAgentKind: binding.externalAgentKind,
          codexThreadId: binding.codexThreadId,
        }),
        binding,
      });
    }),
  });

/** Resolves the default Caara user-state directory from environment and platform state. */
export const resolveCaaraStateDir = ({
  env = process.env,
}: {
  readonly env?: NodeJS.ProcessEnv;
} = {}): string => {
  const xdgStateDir = [env.XDG_STATE_HOME]
    .filter((stateHome): stateHome is string => stateHome !== undefined)
    .map((stateHome) => path.join(stateHome, "caara"))
    .at(0);
  const fallbackHome = env.HOME ?? os.homedir();
  const stateDir = [
    env.CAARA_STATE_DIR,
    xdgStateDir,
    path.join(fallbackHome, ".local", "state", "caara"),
  ]
    .filter((candidate): candidate is string => candidate !== undefined)
    .at(0);

  return Option.getOrThrow(Option.fromUndefinedOr(stateDir));
};

/** Live session directory layer resolved from the current process environment. */
export const sessionDirectoryFromEnvironmentLive = sessionDirectoryLive({
  stateDir: resolveCaaraStateDir(),
});

/** Reconstructs an AgentTarget from persisted mutable target state. */
export const targetFromBinding = (binding: CaaraSessionBinding): AgentTarget =>
  new AgentTarget({
    requestedModel: binding.requestedModel,
    externalAgentKind: binding.externalAgentKind,
    externalModelSpecifier: binding.externalModelSpecifier,
    rawDriverOptions: binding.rawDriverOptions,
  });

/** Chooses an initial cwd for a new external agent binding. */
const initialCwdOption = (codex: CodexTurnContext): Option.Option<string> =>
  Option.fromUndefinedOr([...codex.workspacePaths, ...codex.cwdCandidates].at(0));

/** Prepares binding state for a turn, reusing existing cwd when present. */
export const prepareSessionBinding = Effect.fnUntraced(function* ({
  codex,
  target,
}: {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
}) {
  const directory = yield* SessionDirectory;
  const binding = yield* directory.get({
    externalAgentKind: target.externalAgentKind,
    codexThreadId: codex.threadId,
  });

  return yield* Option.match(binding, {
    onNone: () =>
      Option.match(initialCwdOption(codex), {
        onNone: () =>
          Effect.fail(
            new InvalidResponsesRequest({
              message:
                "A cwd or Codex workspace path is required for a new external code-agent binding.",
            }),
          ),
        onSome: (cwd) =>
          Effect.succeed({
            binding: undefined,
            cwd,
            previousTarget: undefined,
          } satisfies PreparedSessionBinding),
      }),
    onSome: (existingBinding) =>
      Effect.succeed({
        binding: existingBinding,
        cwd: existingBinding.cwd,
        previousTarget: targetFromBinding(existingBinding),
      } satisfies PreparedSessionBinding),
  });
});

/** Persists the completed binding state after a driver reports external session state. */
export const completeSessionBinding = Effect.fnUntraced(function* ({
  codex,
  target,
  prepared,
  externalSession,
}: {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
  readonly prepared: PreparedSessionBinding;
  readonly externalSession: ExternalSessionState;
}) {
  const directory = yield* SessionDirectory;
  const binding = new CaaraSessionBinding({
    codexThreadId: codex.threadId,
    parentCodexSessionId: codex.parentSessionId,
    externalAgentKind: target.externalAgentKind,
    requestedModel: target.requestedModel,
    externalModelSpecifier: target.externalModelSpecifier,
    rawDriverOptions: target.rawDriverOptions,
    externalSession,
    cwd: prepared.cwd,
    createdFromTurnId: prepared.binding?.createdFromTurnId ?? codex.turnId,
    lastTurnId: codex.turnId,
  });
  yield* directory.save(binding);
  return binding;
});
