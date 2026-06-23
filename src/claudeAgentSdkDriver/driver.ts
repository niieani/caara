import { BunCrypto } from "@effect/platform-bun";
import { Context, Crypto, Effect, Layer, Match, Option, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

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
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import {
  ClaudeAgentSdkClient,
  claudeAgentSdkClientLive,
  type ClaudeAgentSdkClientError,
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

/** Builds a reusable cancellation effect around an SDK query runtime. */
const cancelRuntime = (
  runtime: ClaudeAgentSdkQueryRuntime,
): EffectContract<AgentCancellationOutcome> =>
  Effect.catch(
    Effect.tryPromise({
      try: () => runtime.interrupt(),
      catch: (cause) => new AgentDriverError({ message: String(cause) }),
    }).pipe(
      Effect.map(
        () =>
          ({
            _tag: "Interrupted",
            sessionReusable: true,
          }) satisfies AgentCancellationOutcome,
      ),
    ),
    () =>
      Effect.sync(() => runtime.close()).pipe(
        Effect.map(
          () =>
            ({
              _tag: "Terminated",
              sessionReusable: false,
            }) satisfies AgentCancellationOutcome,
        ),
      ),
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
  readonly prompt: string;
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
  turn,
}: {
  readonly client: ClaudeAgentSdkClient["Service"];
  readonly generator: ClaudeAgentSdkSessionIdGenerator["Service"];
  readonly turn: AgentDriverTurn;
}) {
  const prompt = yield* extractClaudeAgentSdkPrompt(turn.prompt.input);
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
}: {
  readonly client: ClaudeAgentSdkClient["Service"];
  readonly generator: ClaudeAgentSdkSessionIdGenerator["Service"];
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
      Match.orElse(() => startContinuableSdkTurn({ client, generator, turn })),
    );
  }),
});

/** Live registry layer that routes Claude targets to the Claude Agent SDK driver. */
export const claudeAgentSdkAgentDriverRegistryLive = Layer.effect(
  AgentDriverRegistry,
  Effect.gen(function* () {
    const client = yield* ClaudeAgentSdkClient;
    const generator = yield* ClaudeAgentSdkSessionIdGenerator;
    const resolve: AgentDriverResolve = (target) =>
      Match.value(target.externalAgentKind).pipe(
        Match.when("claude", () =>
          Effect.succeed(createClaudeAgentSdkAgentDriver({ client, generator })),
        ),
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
);
