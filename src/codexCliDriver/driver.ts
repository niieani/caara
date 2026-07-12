import { Effect, Match, Option, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import { extractAntigravityCliPrompt } from "../antigravityCliDriver/prompt.ts";
import {
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverError,
  type AgentRuntimeEvent,
  createAssistantTextRuntimeEvents,
  createInvalidPromptAgentDriverError,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryDriverPrompt } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";

/** Invocation passed from the common driver into a Codex execution harness. */
export interface CodexCliInvocation {
  readonly cwd: string;
  readonly model: string;
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly lineage: readonly string[];
  readonly depth: number;
}

/** Driver-local activity emitted by a Codex execution harness. */
export type CodexCliActivity =
  | { readonly _tag: "Reasoning"; readonly text: string }
  | { readonly _tag: "Assistant"; readonly text: string }
  | { readonly _tag: "Succeeded" }
  | { readonly _tag: "Failed"; readonly message: string };

/** Running Codex harness returned before its activity stream completes. */
export interface CodexCliRunningTurn {
  readonly sessionId: string;
  readonly runtimeEvents: Stream.Stream<CodexCliActivity, AgentDriverError>;
  readonly cancel: EffectContract<AgentCancellationOutcome>;
}

/** Injectable Codex harness seam used by the external Agent driver. */
export interface CodexCliClient {
  readonly start: (
    invocation: CodexCliInvocation,
  ) => EffectContract<CodexCliRunningTurn, AgentDriverError>;
}

/** Metadata key carrying the comma-separated portable delegation lineage. */
export const caaraLineageMetadataKey = (): string => "caaraLineage";

/** Metadata key carrying the current portable delegation depth. */
export const caaraDepthMetadataKey = (): string => "caaraDepth";

/** Resolves the configurable Codex recursion limit with explicit invalid-value failure. */
export const codexMaximumDepthFromEnvironment = ({
  env,
}: {
  readonly env: Readonly<Record<string, string | undefined>>;
}): EffectContract<number, AgentDriverError> => {
  const maximumDepth = Number(env.CAARA_CODEX_MAXIMUM_DEPTH ?? "3");
  return Effect.filterOrFail(
    Effect.succeed(maximumDepth),
    (value) => Number.isSafeInteger(value) && value > 0,
    () =>
      createInvalidPromptAgentDriverError({
        message: "CAARA_CODEX_MAXIMUM_DEPTH must be a positive integer.",
      }),
  );
};

/** Parses transport-neutral lineage metadata into normalized driver input. */
const delegationOrigin = ({
  metadata,
}: {
  readonly metadata: Readonly<Record<string, string>>;
}): EffectContract<
  { readonly lineage: readonly string[]; readonly depth: number },
  AgentDriverError
> => {
  const lineage = (metadata[caaraLineageMetadataKey()] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const rawDepth = metadata[caaraDepthMetadataKey()] ?? "0";
  const depth = Number(rawDepth);
  return Match.value(Number.isSafeInteger(depth) && depth >= 0).pipe(
    Match.when(true, () => Effect.succeed({ lineage, depth })),
    Match.orElse(() =>
      Effect.fail(
        createInvalidPromptAgentDriverError({
          message: "Invalid Caara delegation depth metadata.",
        }),
      ),
    ),
  );
};

/** Rejects recursive or excessively deep Codex delegation before harness startup. */
const enforceRecursionPolicy = ({
  lineage,
  depth,
  maximumDepth,
}: {
  readonly lineage: readonly string[];
  readonly depth: number;
  readonly maximumDepth: number;
}): EffectContract<void, AgentDriverError> =>
  Effect.filterOrFail(
    Effect.succeed({ lineage, depth }),
    () => !lineage.includes("codex") && depth < maximumDepth,
    () =>
      Match.value(lineage.includes("codex")).pipe(
        Match.when(true, () =>
          createInvalidPromptAgentDriverError({
            message: "Codex-to-Caara recursion rejected for the active delegation lineage.",
          }),
        ),
        Match.orElse(() =>
          createInvalidPromptAgentDriverError({
            message: `Caara delegation depth ${depth} reached configured maximum ${maximumDepth}.`,
          }),
        ),
      ),
  ).pipe(Effect.asVoid);

/** Maps one Codex harness activity into common viewer/runtime events. */
const normalizeCodexActivity = (activity: CodexCliActivity): readonly AgentRuntimeEvent[] =>
  Match.valueTags(activity, {
    Reasoning: ({ text }) =>
      createReasoningSummaryRuntimeEvents({ itemId: crypto.randomUUID(), text }),
    Assistant: ({ text }) =>
      createAssistantTextRuntimeEvents({
        itemId: crypto.randomUUID(),
        text,
        messagePhase: "final_answer",
      }),
    Succeeded: () => [createRuntimeTurnSucceededEvent()],
    Failed: ({ message }) => [
      {
        _tag: "TurnFailed",
        error: createInvalidPromptAgentDriverError({ message }),
      } satisfies AgentRuntimeEvent,
    ],
  });

/** Extracts a prior durable Codex cursor when this turn resumes a session. */
const resumeSessionId = (externalSession: unknown): string | undefined =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(
      [externalSession]
        .filter(
          (session): session is DurableExternalSession => session instanceof DurableExternalSession,
        )
        .map((session) => session.driverResumeCursor)
        .at(0),
    ),
  );

/** Starts Codex, recovering explicitly when a durable resume cursor is unavailable. */
const startWithLostSessionRecovery = Effect.fnUntraced(function* ({
  client,
  invocation,
}: {
  readonly client: CodexCliClient;
  readonly invocation: CodexCliInvocation;
}) {
  const attempted = yield* Effect.result(client.start(invocation));
  return yield* Match.valueTags(attempted, {
    Success: ({ success }) => Effect.succeed({ running: success, lostSessionRecovery: undefined }),
    Failure: Effect.fnUntraced(function* ({ failure }) {
      const resumableFailure =
        invocation.resumeSessionId !== undefined &&
        /resume|session.+(?:missing|not found)/iu.test(failure.message);
      yield* Effect.filterOrFail(
        Effect.succeed(failure),
        () => resumableFailure,
        () => failure,
      );
      const running = yield* client.start({
        cwd: invocation.cwd,
        model: invocation.model,
        prompt: lostSessionRecoveryDriverPrompt,
        lineage: invocation.lineage,
        depth: invocation.depth,
      });
      return {
        running,
        lostSessionRecovery: {
          reason: "codex-resume-unavailable",
          diagnostics: { previousCursor: invocation.resumeSessionId ?? "unknown" },
        },
      };
    }),
  });
});

/** Creates the Codex external Agent driver with explicit recursion controls. */
export const createCodexCliAgentDriver = ({
  client,
  maximumDepth,
}: {
  readonly client: CodexCliClient;
  readonly maximumDepth: number;
}): AgentDriver => ({
  preflight: ({ target }) =>
    Match.value(target.externalAgentKind).pipe(
      Match.when("codex", () => Effect.void),
      Match.orElse(() =>
        Effect.fail(
          createInvalidPromptAgentDriverError({ message: "Codex driver target required." }),
        ),
      ),
    ),
  startOrResumeTurn: Effect.fnUntraced(function* (turn) {
    const origin = yield* delegationOrigin({ metadata: turn.context.origin.metadata });
    yield* enforceRecursionPolicy({ ...origin, maximumDepth });
    const prompt = yield* extractAntigravityCliPrompt(turn.prompt);
    const started = yield* startWithLostSessionRecovery({
      client,
      invocation: {
        cwd: turn.cwd,
        model: turn.target.externalModelSpecifier,
        prompt,
        resumeSessionId: resumeSessionId(turn.externalSession),
        lineage: [...origin.lineage, "codex"],
        depth: origin.depth + 1,
      },
    });
    const running = started.running;
    return {
      runtimeEvents: running.runtimeEvents.pipe(
        Stream.flatMap((activity) => Stream.fromIterable(normalizeCodexActivity(activity))),
      ),
      externalSession: new DurableExternalSession({
        driverResumeCursor: makeDriverResumeCursor(running.sessionId),
      }),
      cancel: running.cancel,
      lostSessionRecovery: started.lostSessionRecovery,
    };
  }),
});
