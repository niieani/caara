import { Effect, Match, Option, Stream } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import { extractAntigravityCliPrompt } from "../antigravityCliDriver/prompt.ts";
import { delegationChildEnvironment } from "../mockResponsesProvider/agentDelegation.ts";
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
  /** Delegation markers Caara injects into the Codex process environment. */
  readonly delegationEnvironment: Readonly<Record<string, string>>;
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
        delegationEnvironment: invocation.delegationEnvironment,
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

/** Creates the Codex external Agent driver around an injectable Codex harness client. */
export const createCodexCliAgentDriver = ({
  client,
}: {
  readonly client: CodexCliClient;
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
    const prompt = yield* extractAntigravityCliPrompt(turn.prompt);
    const started = yield* startWithLostSessionRecovery({
      client,
      invocation: {
        cwd: turn.cwd,
        model: turn.target.externalModelSpecifier,
        prompt,
        resumeSessionId: resumeSessionId(turn.externalSession),
        delegationEnvironment: delegationChildEnvironment({
          delegation: turn.context.delegation,
          harness: "codex",
        }),
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
