import { Context, Effect, Option, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import type { AgentTurnContext } from "./agentTurnContext.ts";
import { AgentTarget } from "./codexTurnContext.ts";
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
    delegationLineage: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    delegationDepth: Schema.optional(
      Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    ),
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
  context,
  target,
}: {
  readonly context: AgentTurnContext;
  readonly target: AgentTarget;
}): SessionBindingKey => ({
  externalAgentKind: makeExternalAgentKind(target.externalAgentKind),
  driverInstanceId: makeDriverInstanceId(driverInstanceIdFromTarget(target)),
  codexThreadId: makeCodexThreadId(context.identity.sessionId),
});

/** Builds the latest API response id persisted with a completed turn. */
const apiResponseIdFromTurn = (context: AgentTurnContext): ApiResponseId =>
  makeApiResponseId(`resp_${context.identity.turnId}`);

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
const initialCwdOption = (context: AgentTurnContext): Option.Option<string> =>
  Option.fromUndefinedOr(context.requestedCwd);

/** Prepares binding state for a turn, reusing existing cwd when present. */
export const prepareSessionBinding = Effect.fnUntraced(function* ({
  context,
  target,
}: {
  readonly context: AgentTurnContext;
  readonly target: AgentTarget;
}) {
  const directory = yield* SessionDirectory;
  const key = sessionBindingKeyFromTurn({ context, target });
  const binding = yield* directory.get(key);
  const requestedCwd = Option.getOrUndefined(initialCwdOption(context));

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
  context,
  target,
  prepared,
  externalSession,
  bindingCwd,
}: {
  readonly context: AgentTurnContext;
  readonly target: AgentTarget;
  readonly prepared: PreparedSessionBinding;
  readonly externalSession: ExternalSessionState;
  readonly bindingCwd?: string;
}) {
  const directory = yield* SessionDirectory;
  const bindingKey = sessionBindingKeyFromTurn({ context, target });
  const binding = new CaaraSessionBinding({
    schemaVersion: 2,
    apiResponseId: apiResponseIdFromTurn(context),
    bindingKey,
    parentCodexSessionId: makeCodexParentSessionId(context.identity.parentSessionId),
    requestedTarget: requestedTargetStateFromTarget(target),
    externalSession,
    cwd: bindingCwd ?? prepared.cwd,
    createdFromTurnId:
      prepared.binding?.createdFromTurnId ?? makeCodexTurnId(context.identity.turnId),
    lastTurnId: makeCodexTurnId(context.identity.turnId),
  });
  yield* directory.save(binding);
  return binding;
});

/** Deletes a session binding after a driver reports the external session is not reusable. */
export const deleteSessionBinding = Effect.fnUntraced(function* ({
  context,
  target,
}: {
  readonly context: AgentTurnContext;
  readonly target: AgentTarget;
}) {
  const directory = yield* SessionDirectory;
  yield* directory.delete(sessionBindingKeyFromTurn({ context, target }));
});
