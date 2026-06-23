import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Context, Effect, Layer, Option, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import { AgentTarget, type CodexTurnContext } from "./codexTurnContext.ts";
import { InvalidResponsesRequest } from "./errors.ts";

/** API response id persisted with the latest completed Caara turn. */
export const ApiResponseId = Schema.NonEmptyString.pipe(Schema.brand("ApiResponseId"));

/** API response id persisted with the latest completed Caara turn. */
export type ApiResponseId = typeof ApiResponseId.Type;

/** External agent kind persisted as part of the session binding identity. */
export const ExternalAgentKind = Schema.NonEmptyString.pipe(Schema.brand("ExternalAgentKind"));

/** External agent kind persisted as part of the session binding identity. */
export type ExternalAgentKind = typeof ExternalAgentKind.Type;

/** Driver instance identity persisted as part of the session binding identity. */
export const DriverInstanceId = Schema.NonEmptyString.pipe(Schema.brand("DriverInstanceId"));

/** Driver instance identity persisted as part of the session binding identity. */
export type DriverInstanceId = typeof DriverInstanceId.Type;

/** Codex thread id persisted as part of the session binding identity. */
export const CodexThreadId = Schema.NonEmptyString.pipe(Schema.brand("CodexThreadId"));

/** Codex thread id persisted as part of the session binding identity. */
export type CodexThreadId = typeof CodexThreadId.Type;

/** Codex parent session id persisted for diagnostics and future recovery policies. */
export const CodexParentSessionId = Schema.NonEmptyString.pipe(
  Schema.brand("CodexParentSessionId"),
);

/** Codex parent session id persisted for diagnostics and future recovery policies. */
export type CodexParentSessionId = typeof CodexParentSessionId.Type;

/** Codex turn id persisted for binding creation and latest-turn tracking. */
export const CodexTurnId = Schema.NonEmptyString.pipe(Schema.brand("CodexTurnId"));

/** Codex turn id persisted for binding creation and latest-turn tracking. */
export type CodexTurnId = typeof CodexTurnId.Type;

/** Requested Responses model string persisted as mutable binding state. */
export const RequestedModelSpecifier = Schema.NonEmptyString.pipe(
  Schema.brand("RequestedModelSpecifier"),
);

/** Requested Responses model string persisted as mutable binding state. */
export type RequestedModelSpecifier = typeof RequestedModelSpecifier.Type;

/** Driver-local model string persisted as mutable binding state. */
export const ExternalModelSpecifier = Schema.NonEmptyString.pipe(
  Schema.brand("ExternalModelSpecifier"),
);

/** Driver-local model string persisted as mutable binding state. */
export type ExternalModelSpecifier = typeof ExternalModelSpecifier.Type;

/** Opaque resume cursor owned by the selected driver. */
export const DriverResumeCursor = Schema.NonEmptyString.pipe(Schema.brand("DriverResumeCursor"));

/** Opaque resume cursor owned by the selected driver. */
export type DriverResumeCursor = typeof DriverResumeCursor.Type;

/** Brands a latest API response id after deterministic construction. */
export const makeApiResponseId = (value: string): ApiResponseId => ApiResponseId.make(value);

/** Brands an external agent kind after transport decoding or persisted decoding. */
export const makeExternalAgentKind = (value: string): ExternalAgentKind =>
  ExternalAgentKind.make(value);

/** Brands a driver instance id after registry routing. */
export const makeDriverInstanceId = (value: string): DriverInstanceId =>
  DriverInstanceId.make(value);

/** Brands a Codex thread id after Codex identity decoding. */
export const makeCodexThreadId = (value: string): CodexThreadId => CodexThreadId.make(value);

/** Brands a Codex parent session id after Codex identity decoding. */
export const makeCodexParentSessionId = (value: string): CodexParentSessionId =>
  CodexParentSessionId.make(value);

/** Brands a Codex turn id after Codex metadata decoding. */
export const makeCodexTurnId = (value: string): CodexTurnId => CodexTurnId.make(value);

/** Brands a requested Responses model specifier after target parsing. */
export const makeRequestedModelSpecifier = (value: string): RequestedModelSpecifier =>
  RequestedModelSpecifier.make(value);

/** Brands a driver-local model specifier after target parsing. */
export const makeExternalModelSpecifier = (value: string): ExternalModelSpecifier =>
  ExternalModelSpecifier.make(value);

/** Brands an opaque driver-owned resume cursor. */
export const makeDriverResumeCursor = (value: string): DriverResumeCursor =>
  DriverResumeCursor.make(value);

/** Stable identity key for one persisted Caara session binding. */
export const SessionBindingKey = Schema.Struct({
  externalAgentKind: ExternalAgentKind,
  driverInstanceId: DriverInstanceId,
  codexThreadId: CodexThreadId,
});

/** Stable identity key for one persisted Caara session binding. */
export type SessionBindingKey = typeof SessionBindingKey.Type;

/** Mutable requested target state stored on an existing session binding. */
export const RequestedTargetState = Schema.Struct({
  requestedModel: RequestedModelSpecifier,
  externalModelSpecifier: ExternalModelSpecifier,
  rawDriverOptions: Schema.Record(Schema.String, Schema.String),
});

/** Mutable requested target state stored on an existing session binding. */
export type RequestedTargetState = typeof RequestedTargetState.Type;

/** Durable external session state stored by Caara for resumable drivers. */
export class DurableExternalSession extends Schema.TaggedClass<DurableExternalSession>()(
  "Durable",
  {
    driverResumeCursor: DriverResumeCursor,
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
  schemaVersion: Schema.Literal(2),
  apiResponseId: ApiResponseId,
  bindingKey: SessionBindingKey,
  parentCodexSessionId: CodexParentSessionId,
  requestedTarget: RequestedTargetState,
  externalSession: ExternalSessionState,
  cwd: Schema.NonEmptyString,
  createdFromTurnId: CodexTurnId,
  lastTurnId: CodexTurnId,
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
  readonly requestedCwd: string | undefined;
  readonly previousTarget: AgentTarget | undefined;
}

/** Session directory service used to persist durable binding metadata. */
export class SessionDirectory extends Context.Service<
  SessionDirectory,
  {
    readonly get: SessionDirectoryGet;
    readonly save: SessionDirectorySave;
    readonly delete: SessionDirectoryDelete;
  }
>()("@caara/SessionDirectory") {}

/** Filesystem path options for one session binding file. */
export interface SessionBindingFilePathOptions {
  readonly stateDir: string;
  readonly externalAgentKind: string;
  readonly driverInstanceId: string;
  readonly codexThreadId: string;
}

/** Contract for looking up one persisted session binding. */
export type SessionDirectoryGet = (
  key: SessionBindingKey,
) => EffectContract<Option.Option<CaaraSessionBinding>, SessionDirectoryError>;

/** Contract for saving one persisted session binding. */
export type SessionDirectorySave = (
  binding: CaaraSessionBinding,
) => EffectContract<void, SessionDirectoryError>;

/** Contract for deleting one persisted session binding. */
export type SessionDirectoryDelete = (
  key: SessionBindingKey,
) => EffectContract<void, SessionDirectoryError>;

/** Encodes one session key component into a safe filesystem segment. */
const encodeSessionPathSegment = (segment: string): string => encodeURIComponent(segment);

/** Returns the durable binding file path for one session key. */
export const sessionBindingFilePath = ({
  stateDir,
  externalAgentKind,
  driverInstanceId,
  codexThreadId,
}: SessionBindingFilePathOptions): string =>
  path.join(
    stateDir,
    "sessions",
    encodeSessionPathSegment(externalAgentKind),
    encodeSessionPathSegment(driverInstanceId),
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

/** Deletes a binding file when cancellation makes its external session unusable. */
const deleteBindingFile = Effect.fnUntraced(function* ({
  filePath,
}: {
  readonly filePath: string;
}) {
  yield* Effect.tryPromise({
    try: () => fs.rm(filePath, { force: true }),
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
          ...binding.bindingKey,
        }),
        binding,
      });
    }),
    delete: Effect.fnUntraced(function* (key: SessionBindingKey) {
      yield* deleteBindingFile({ filePath: sessionBindingFilePath({ stateDir, ...key }) });
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
    requestedModel: binding.requestedTarget.requestedModel,
    externalAgentKind: binding.bindingKey.externalAgentKind,
    externalModelSpecifier: binding.requestedTarget.externalModelSpecifier,
    rawDriverOptions: binding.requestedTarget.rawDriverOptions,
  });

/** Derives the prototype driver instance id for a target. */
export const driverInstanceIdFromTarget = (target: AgentTarget): string => target.externalAgentKind;

/** Builds the persisted session binding key for one selected target and Codex thread. */
export const sessionBindingKeyFromTurn = ({
  codex,
  target,
}: {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
}): SessionBindingKey => ({
  externalAgentKind: makeExternalAgentKind(target.externalAgentKind),
  driverInstanceId: makeDriverInstanceId(driverInstanceIdFromTarget(target)),
  codexThreadId: makeCodexThreadId(codex.threadId),
});

/** Builds the latest API response id persisted with a completed turn. */
const apiResponseIdFromTurn = (codex: CodexTurnContext): ApiResponseId =>
  makeApiResponseId(`resp_${codex.turnId}`);

/** Extracts mutable requested target state from a selected target. */
const requestedTargetStateFromTarget = (target: AgentTarget): RequestedTargetState => ({
  requestedModel: makeRequestedModelSpecifier(target.requestedModel),
  externalModelSpecifier: makeExternalModelSpecifier(target.externalModelSpecifier),
  rawDriverOptions: target.rawDriverOptions,
});

/** Builds the first binding/key mismatch message, if the persisted file is inconsistent. */
const bindingKeyMismatchMessage = ({
  binding,
  key,
}: {
  readonly binding: CaaraSessionBinding;
  readonly key: SessionBindingKey;
}): Option.Option<string> =>
  Option.fromUndefinedOr(
    [
      ["external agent kind", key.externalAgentKind, binding.bindingKey.externalAgentKind],
      ["driver instance id", key.driverInstanceId, binding.bindingKey.driverInstanceId],
      ["Codex thread id", key.codexThreadId, binding.bindingKey.codexThreadId],
    ].find(([, expected, actual]) => actual !== expected),
  ).pipe(
    Option.map(
      ([label, expected, actual]) =>
        `Persisted session binding ${label} mismatch: expected ${expected}, received ${actual}.`,
    ),
  );

/** Validates that a loaded binding belongs to the selected driver/thread key. */
const validateLoadedBinding = Effect.fnUntraced(function* ({
  binding,
  key,
}: {
  readonly binding: CaaraSessionBinding;
  readonly key: SessionBindingKey;
}) {
  return yield* Option.match(bindingKeyMismatchMessage({ binding, key }), {
    onNone: () => Effect.succeed(binding),
    onSome: (message) => Effect.fail(new InvalidResponsesRequest({ message })),
  });
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
  const key = sessionBindingKeyFromTurn({ codex, target });
  const binding = yield* directory.get(key);
  const requestedCwd = Option.getOrUndefined(initialCwdOption(codex));

  return yield* Option.match(binding, {
    onNone: () =>
      Option.match(Option.fromUndefinedOr(requestedCwd), {
        onNone: () =>
          Effect.fail(
            new InvalidResponsesRequest({
              message:
                "No existing session binding was found for this follow-up turn, and no cwd or Codex workspace path was provided for a new external code-agent binding.",
            }),
          ),
        onSome: (cwd) =>
          Effect.succeed({
            binding: undefined,
            cwd,
            requestedCwd: cwd,
            previousTarget: undefined,
          } satisfies PreparedSessionBinding),
      }),
    onSome: (existingBinding) =>
      Effect.map(
        validateLoadedBinding({ binding: existingBinding, key }),
        (validatedBinding) =>
          ({
            binding: validatedBinding,
            cwd: validatedBinding.cwd,
            requestedCwd,
            previousTarget: targetFromBinding(validatedBinding),
          }) satisfies PreparedSessionBinding,
      ),
  });
});

/** Persists the completed binding state after a driver reports external session state. */
export const completeSessionBinding = Effect.fnUntraced(function* ({
  codex,
  target,
  prepared,
  externalSession,
  bindingCwd,
}: {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
  readonly prepared: PreparedSessionBinding;
  readonly externalSession: ExternalSessionState;
  readonly bindingCwd?: string;
}) {
  const directory = yield* SessionDirectory;
  const bindingKey = sessionBindingKeyFromTurn({ codex, target });
  const binding = new CaaraSessionBinding({
    schemaVersion: 2,
    apiResponseId: apiResponseIdFromTurn(codex),
    bindingKey,
    parentCodexSessionId: makeCodexParentSessionId(codex.parentSessionId),
    requestedTarget: requestedTargetStateFromTarget(target),
    externalSession,
    cwd: bindingCwd ?? prepared.cwd,
    createdFromTurnId: prepared.binding?.createdFromTurnId ?? makeCodexTurnId(codex.turnId),
    lastTurnId: makeCodexTurnId(codex.turnId),
  });
  yield* directory.save(binding);
  return binding;
});

/** Deletes a session binding after a driver reports the external session is not reusable. */
export const deleteSessionBinding = Effect.fnUntraced(function* ({
  codex,
  target,
}: {
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
}) {
  const directory = yield* SessionDirectory;
  yield* directory.delete(sessionBindingKeyFromTurn({ codex, target }));
});
