import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BunCrypto, BunServices } from "@effect/platform-bun";
import { Context, Crypto, Effect, Layer, Match, Option, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import * as Path from "effect/Path";

import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverResolve,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  unsupportedExternalAgentKindError,
} from "../mockResponsesProvider/agentDriver.ts";
import { diagnosticAgentDriver } from "../mockResponsesProvider/diagnosticDriver.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import {
  ClaudeAgentSdkClient,
  claudeAgentSdkClientLive,
  type ClaudeAgentSdkClientError,
  type ClaudeAgentSdkQueryPrompt,
  type ClaudeAgentSdkQueryRuntime,
} from "./claudeAgentSdkClient.ts";
import { runtimeEventsFromClaudeAgentSdkQuery } from "./events.ts";
import { buildClaudeAgentSdkQueryOptions, type ClaudeAgentSdkSessionStartup } from "./options.ts";
import { extractClaudeAgentSdkPrompt } from "./prompt.ts";

/** Service used to generate SDK session ids behind an injectable seam. */
export class ClaudeAgentSdkSessionIdGenerator extends Context.Service<
  ClaudeAgentSdkSessionIdGenerator,
  {
    readonly nextSessionId: EffectContract<string, AgentDriverError>;
  }
>()("@caara/ClaudeAgentSdkSessionIdGenerator") {}

/** Live SDK session-id generator backed by the platform Crypto service. */
export const claudeAgentSdkSessionIdGeneratorLive = Layer.effect(
  ClaudeAgentSdkSessionIdGenerator,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return {
      nextSessionId: crypto.randomUUIDv4.pipe(
        Effect.mapError((error) => new AgentDriverError({ message: error.message })),
      ),
    };
  }),
).pipe(Layer.provide(BunCrypto.layer));

/** Maps SDK client construction errors into driver-facing failures. */
const clientErrorToDriverError = (error: ClaudeAgentSdkClientError): AgentDriverError =>
  new AgentDriverError({ message: error.message });

/** Extracts a durable Claude SDK resume cursor from prior external session state. */
const durableResumeCursorOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(
    [turn.externalSession]
      .filter((session): session is DurableExternalSession => session?._tag === "Durable")
      .map((session) => session.driverResumeCursor)
      .at(0),
  );

/** Returns the inbound cwd requested by the current Codex turn when present. */
const requestedCwdOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(turn.requestedCwd);

/** Returns true when a requested cwd change breaks external session continuity. */
const requiresFreshSessionForCwdChange = (turn: AgentDriverTurn): boolean => {
  const requestedCwd = Option.getOrUndefined(requestedCwdOption(turn));
  return (
    Option.isSome(durableResumeCursorOption(turn)) &&
    requestedCwd !== undefined &&
    requestedCwd !== turn.cwd
  );
};

/** Builds the standard durable session state for a Claude SDK session id. */
const durableSession = (sessionId: string): DurableExternalSession =>
  new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(sessionId),
  });

/** SDK result message observed while draining an interrupted query. */
type ClaudeAgentSdkResultMessage = Extract<SDKMessage, { readonly type: "result" }>;

/** Builds a reusable interrupted cancellation outcome. */
const interruptedCancellationOutcome = (): AgentCancellationOutcome => ({
  _tag: "Interrupted",
  sessionReusable: true,
});

/** Builds a non-reusable terminated cancellation outcome. */
const terminatedCancellationOutcome = (): AgentCancellationOutcome => ({
  _tag: "Terminated",
  sessionReusable: false,
});

/** Returns true when the SDK terminal reason proves a clean user interruption. */
const isCleanSdkCancellationResult = (message: ClaudeAgentSdkResultMessage): boolean =>
  message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools";

/** Reads the next SDK cancellation-drain message through the typed driver error seam. */
const readNextCancellationMessage = ({
  iterator,
}: {
  readonly iterator: AsyncIterator<SDKMessage>;
}): EffectContract<IteratorResult<SDKMessage>, AgentDriverError> =>
  Effect.tryPromise({
    try: () => iterator.next(),
    catch: (cause) => new AgentDriverError({ message: String(cause) }),
  });

/** Returns true when one iterator result yielded a terminal SDK result message. */
const isSdkResultIteratorYield = (
  result: IteratorResult<SDKMessage>,
): result is IteratorYieldResult<ClaudeAgentSdkResultMessage> =>
  result.done !== true && result.value.type === "result";

/** Drains SDK messages until a terminal result message or stream end is observed. */
const drainCancellationResult: (input: {
  readonly iterator: AsyncIterator<SDKMessage>;
}) => EffectContract<Option.Option<ClaudeAgentSdkResultMessage>, AgentDriverError> =
  Effect.fnUntraced(function* ({ iterator }: { readonly iterator: AsyncIterator<SDKMessage> }) {
    const next = yield* readNextCancellationMessage({ iterator });
    return yield* Match.value(next).pipe(
      Match.when({ done: true }, () => Effect.succeed(Option.none<ClaudeAgentSdkResultMessage>())),
      Match.when(isSdkResultIteratorYield, ({ value }) => Effect.succeed(Option.some(value))),
      Match.orElse(() => drainCancellationResult({ iterator })),
    );
  });

/** Converts an optional drained SDK result into the driver cancellation contract. */
const outcomeFromCancellationResult = (
  result: Option.Option<Option.Option<ClaudeAgentSdkResultMessage>>,
): AgentCancellationOutcome =>
  Option.match(result, {
    onNone: terminatedCancellationOutcome,
    onSome: (messageOption) =>
      Option.match(messageOption, {
        onNone: terminatedCancellationOutcome,
        onSome: (message) =>
          Match.value(isCleanSdkCancellationResult(message)).pipe(
            Match.when(true, interruptedCancellationOutcome),
            Match.orElse(terminatedCancellationOutcome),
          ),
      }),
  });

/** Closes an SDK runtime and reports a non-reusable terminated cancellation. */
const closeRuntimeAsTerminated = (
  runtime: ClaudeAgentSdkQueryRuntime,
): EffectContract<AgentCancellationOutcome> =>
  Effect.sync(() => runtime.close()).pipe(Effect.map(terminatedCancellationOutcome));

/** Closes the runtime when cancellation did not prove reusable session state. */
const finalizeCancellationOutcome = ({
  runtime,
  outcome,
}: {
  readonly runtime: ClaudeAgentSdkQueryRuntime;
  readonly outcome: AgentCancellationOutcome;
}): EffectContract<AgentCancellationOutcome> =>
  Match.value(outcome.sessionReusable).pipe(
    Match.when(true, () => Effect.succeed(outcome)),
    Match.orElse(() => closeRuntimeAsTerminated(runtime)),
  );

/** Drains one interrupted SDK runtime through the bounded cancellation policy. */
const drainRuntimeCancellation = (
  runtime: ClaudeAgentSdkQueryRuntime,
): EffectContract<AgentCancellationOutcome, AgentDriverError> =>
  drainCancellationResult({ iterator: runtime[Symbol.asyncIterator]() }).pipe(
    Effect.timeoutOption("1 second"),
    Effect.map(outcomeFromCancellationResult),
  );

/** Builds a reusable cancellation effect around an SDK query runtime. */
const cancelRuntime = (
  runtime: ClaudeAgentSdkQueryRuntime,
): EffectContract<AgentCancellationOutcome> =>
  Effect.catch(
    Effect.tryPromise({
      try: () => runtime.interrupt(),
      catch: (cause) => new AgentDriverError({ message: String(cause) }),
    }).pipe(
      Effect.flatMap(() => drainRuntimeCancellation(runtime)),
      Effect.flatMap((outcome) => finalizeCancellationOutcome({ runtime, outcome })),
    ),
    () => closeRuntimeAsTerminated(runtime),
  );

/** Applies in-place SDK controls for target changes supported by the query runtime. */
const applyInPlaceTargetChanges = Effect.fnUntraced(function* ({
  runtime,
  turn,
}: {
  readonly runtime: ClaudeAgentSdkQueryRuntime;
  readonly turn: AgentDriverTurn;
}) {
  const modelChanged = Option.fromUndefinedOr(turn.previousTarget).pipe(
    Option.filter(
      (previousTarget) =>
        previousTarget.externalModelSpecifier !== turn.target.externalModelSpecifier,
    ),
  );
  yield* Option.match(modelChanged, {
    onNone: () => Effect.void,
    onSome: () =>
      Effect.tryPromise({
        try: () => runtime.setModel(turn.target.externalModelSpecifier),
        catch: (cause) => new AgentDriverError({ message: String(cause) }),
      }),
  });
});

/** Starts one SDK query and wraps it in the driver turn result contract. */
const sdkQueryTurnResult = Effect.fnUntraced(function* ({
  client,
  turn,
  prompt,
  startup,
  cursor,
  cwd,
}: {
  readonly client: ClaudeAgentSdkClient["Service"];
  readonly turn: AgentDriverTurn;
  readonly prompt: ClaudeAgentSdkQueryPrompt;
  readonly startup: ClaudeAgentSdkSessionStartup;
  readonly cursor: string;
  readonly cwd: string;
}) {
  const options = yield* buildClaudeAgentSdkQueryOptions({
    cwd,
    model: turn.target.externalModelSpecifier,
    rawDriverOptions: turn.target.rawDriverOptions,
    startup,
  });
  const runtime = yield* client
    .query({ prompt, options })
    .pipe(Effect.mapError(clientErrorToDriverError));
  yield* applyInPlaceTargetChanges({ runtime, turn });

  return {
    runtimeEvents: runtimeEventsFromClaudeAgentSdkQuery({ runtime }),
    externalSession: durableSession(cursor),
    cancel: cancelRuntime(runtime),
  } satisfies AgentDriverTurnResult;
});

/** Converts a failed SDK resume query into a fresh-session lost-continuity recovery. */
const recoverFailedResumeQuery = ({
  turnResult,
  client,
  generator,
  turn,
  resume,
}: {
  readonly turnResult: EffectContract<AgentDriverTurnResult, AgentDriverError>;
  readonly client: ClaudeAgentSdkClient["Service"];
  readonly generator: ClaudeAgentSdkSessionIdGenerator["Service"];
  readonly turn: AgentDriverTurn;
  readonly resume: string;
}) =>
  turnResult.pipe(
    Effect.catchTag("AgentDriverError", (error) =>
      recoverWithFreshSdkSession({
        client,
        generator,
        turn,
        reason: "sdk-resume-query-failed",
        diagnostics: {
          message: error.message,
          previousCursor: resume,
        },
        freshCwd: turn.cwd,
      }),
    ),
  );

/** Starts a fresh SDK session and returns typed lost-continuity recovery metadata. */
const recoverWithFreshSdkSession = Effect.fnUntraced(function* ({
  client,
  generator,
  turn,
  reason,
  diagnostics,
  freshCwd,
}: {
  readonly client: ClaudeAgentSdkClient["Service"];
  readonly generator: ClaudeAgentSdkSessionIdGenerator["Service"];
  readonly turn: AgentDriverTurn;
  readonly reason: string;
  readonly diagnostics: Readonly<Record<string, string>>;
  readonly freshCwd: string;
}) {
  const sessionId = yield* generator.nextSessionId;
  const options = yield* buildClaudeAgentSdkQueryOptions({
    cwd: freshCwd,
    model: turn.target.externalModelSpecifier,
    rawDriverOptions: turn.target.rawDriverOptions,
    startup: { _tag: "Start", sessionId },
  });
  yield* client.query({ prompt: lostSessionRecoveryDriverPrompt, options }).pipe(
    Effect.mapError(
      (error) =>
        new AgentDriverError({
          message: `Claude Agent SDK could not preserve Claude SDK session continuity or start a fresh external session: ${error.message}`,
        }),
    ),
  );

  return {
    runtimeEvents: Stream.empty,
    externalSession: durableSession(sessionId),
    bindingCwd: freshCwd,
    lostSessionRecovery: {
      reason,
      diagnostics,
    },
    cancel: Effect.succeed({
      _tag: "Interrupted",
      sessionReusable: true,
    } satisfies AgentCancellationOutcome),
  } satisfies AgentDriverTurnResult;
});

/** Starts or resumes a continuity-preserving SDK query. */
const startContinuableSdkTurn = Effect.fnUntraced(function* ({
  client,
  generator,
  pathService,
  turn,
}: {
  readonly client: ClaudeAgentSdkClient["Service"];
  readonly generator: ClaudeAgentSdkSessionIdGenerator["Service"];
  readonly pathService: Path.Path;
  readonly turn: AgentDriverTurn;
}) {
  const prompt = yield* extractClaudeAgentSdkPrompt({
    cwd: turn.cwd,
    input: turn.prompt.input,
  }).pipe(Effect.provideService(Path.Path, pathService));
  const startup = yield* Option.match(durableResumeCursorOption(turn), {
    onNone: () =>
      Effect.map(generator.nextSessionId, (sessionId) => ({
        startup: { _tag: "Start", sessionId } as const,
        cursor: sessionId,
      })),
    onSome: (resume) =>
      Effect.succeed({
        startup: { _tag: "Resume", resume } as const,
        cursor: resume,
      }),
  });

  const turnResult = sdkQueryTurnResult({
    client,
    turn,
    prompt,
    startup: startup.startup,
    cursor: startup.cursor,
    cwd: turn.cwd,
  });
  return yield* Match.value(startup.startup).pipe(
    Match.tags({
      Start: () => turnResult,
      Resume: ({ resume }) =>
        recoverFailedResumeQuery({
          turnResult,
          client,
          generator,
          turn,
          resume,
        }),
    }),
    Match.exhaustive,
  );
});

/** Builds a Claude Agent SDK agent driver from injected SDK services. */
const createClaudeAgentSdkAgentDriver = ({
  client,
  generator,
  pathService,
}: {
  readonly client: ClaudeAgentSdkClient["Service"];
  readonly generator: ClaudeAgentSdkSessionIdGenerator["Service"];
  readonly pathService: Path.Path;
}): AgentDriver => ({
  startOrResumeTurn: Effect.fnUntraced(function* (turn: AgentDriverTurn) {
    return yield* Match.value(requiresFreshSessionForCwdChange(turn)).pipe(
      Match.when(true, () =>
        recoverWithFreshSdkSession({
          client,
          generator,
          turn,
          reason: "cwd-changed",
          diagnostics: {
            previousCwd: turn.cwd,
            requestedCwd: turn.requestedCwd ?? "unknown",
            previousCursor: Option.getOrUndefined(durableResumeCursorOption(turn)) ?? "unknown",
          },
          freshCwd: turn.requestedCwd ?? turn.cwd,
        }),
      ),
      Match.orElse(() => startContinuableSdkTurn({ client, generator, pathService, turn })),
    );
  }),
});

/** Live registry layer that routes Claude targets to the Claude Agent SDK driver. */
export const claudeAgentSdkAgentDriverRegistryLive = Layer.effect(
  AgentDriverRegistry,
  Effect.gen(function* () {
    const client = yield* ClaudeAgentSdkClient;
    const generator = yield* ClaudeAgentSdkSessionIdGenerator;
    const pathService = yield* Path.Path;
    const resolve: AgentDriverResolve = (target) =>
      Match.value(target.externalAgentKind).pipe(
        Match.when("claude", () =>
          Effect.succeed(createClaudeAgentSdkAgentDriver({ client, generator, pathService })),
        ),
        Match.when("diagnostic", () => Effect.succeed(diagnosticAgentDriver)),
        Match.orElse((externalAgentKind) =>
          Effect.fail(
            unsupportedExternalAgentKindError({
              externalAgentKind,
            }),
          ),
        ),
      );
    return { resolve };
  }),
);

/** Live Claude Agent SDK driver stack for the application entrypoint. */
export const claudeAgentSdkDriverLive = claudeAgentSdkAgentDriverRegistryLive.pipe(
  Layer.provideMerge(claudeAgentSdkClientLive),
  Layer.provideMerge(claudeAgentSdkSessionIdGeneratorLive),
  Layer.provideMerge(BunServices.layer),
);
