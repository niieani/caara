import type { Options as ClaudeQueryOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Match, Option, Stream } from "effect";
import * as Path from "effect/Path";

import { caaraSettingsDefaultLayer } from "../caaraSettings.ts";
import {
  AgentDriverRegistry,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
} from "../mockResponsesProvider/agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import {
  ClaudeAgentSdkClient,
  ClaudeAgentSdkClientError,
  type ClaudeAgentSdkQueryRequest,
  type ClaudeAgentSdkQueryRuntime,
} from "./claudeAgentSdkClient.ts";
import {
  assertRequestsUseNonInteractivePermissionPolicy,
  queryOptionsWithoutPermissionPolicy,
} from "./claudeAgentSdkTestAssertions.ts";
import {
  ClaudeAgentSdkSessionIdGenerator,
  claudeAgentSdkAgentDriverRegistryLive,
} from "./driver.ts";
import { ClaudeAgentSdkSettings } from "./settings.ts";

/** Stable cwd used by SDK recovery tests. */
const projectRoot = process.cwd();

/** SDK query request with non-optional options for assertions. */
interface RecordedQueryRequest {
  readonly prompt: ClaudeAgentSdkQueryRequest["prompt"];
  readonly options: ClaudeQueryOptions;
}

/** Builds a fake SDK query runtime that emits fixed messages. */
const fakeRuntime = (messages: readonly SDKMessage[]): ClaudeAgentSdkQueryRuntime => ({
  interrupt: () => Promise.resolve(),
  close: () => {},
  setModel: () => Promise.resolve(),
  setPermissionMode: () => Promise.resolve(),
  setMaxThinkingTokens: () => Promise.resolve(),
  [Symbol.asyncIterator]: () => {
    let index = 0;
    return {
      next: () => {
        const message = messages.at(index);
        index += 1;
        return Option.match(Option.fromUndefinedOr(message), {
          onNone: () =>
            Promise.resolve({ done: true, value: undefined } satisfies IteratorReturnResult<void>),
          onSome: (nextMessage) =>
            Promise.resolve({
              done: false,
              value: nextMessage,
            } satisfies IteratorYieldResult<SDKMessage>),
        });
      },
    };
  },
});

/** Converts an ordered fake SDK outcome into the SDK client query effect. */
const fakeSdkOutcomeEffect = (
  outcome: ClaudeAgentSdkQueryRuntime | ClaudeAgentSdkClientError | undefined,
) => {
  const error = Option.fromUndefinedOr(
    [outcome]
      .filter(
        (candidate): candidate is ClaudeAgentSdkClientError =>
          candidate instanceof ClaudeAgentSdkClientError,
      )
      .at(0),
  );
  const runtime = Option.fromUndefinedOr(
    [outcome]
      .filter(
        (candidate): candidate is ClaudeAgentSdkQueryRuntime =>
          candidate !== undefined && !(candidate instanceof ClaudeAgentSdkClientError),
      )
      .at(0),
  );
  return Option.match(error, {
    onNone: () =>
      Option.match(runtime, {
        onNone: () =>
          Effect.fail(new ClaudeAgentSdkClientError({ message: "missing fake SDK outcome" })),
        onSome: Effect.succeed,
      }),
    onSome: Effect.fail,
  });
};

/** Builds a fake SDK client layer with ordered query outcomes. */
const fakeSdkClientLayer = ({
  recordedRequests,
  outcomes,
}: {
  readonly recordedRequests: RecordedQueryRequest[];
  readonly outcomes: readonly (ClaudeAgentSdkQueryRuntime | ClaudeAgentSdkClientError)[];
}) => {
  let outcomeIndex = 0;
  return Layer.succeed(ClaudeAgentSdkClient, {
    query: (request) =>
      Effect.sync(() => {
        const outcome = outcomes.at(outcomeIndex);
        outcomeIndex += 1;
        recordedRequests.push({
          prompt: request.prompt,
          options: request.options,
        });
        return outcome;
      }).pipe(Effect.flatMap(fakeSdkOutcomeEffect)),
  });
};

/** Builds a deterministic SDK session-id generator layer. */
const fakeSessionIdLayer = ({ sessionIds }: { readonly sessionIds: readonly string[] }) => {
  let sessionIndex = 0;
  return Layer.succeed(ClaudeAgentSdkSessionIdGenerator, {
    nextSessionId: Effect.sync(() => {
      const sessionId = sessionIds.at(sessionIndex);
      sessionIndex += 1;
      assert.ok(sessionId, "missing fake session id");
      return sessionId;
    }),
  });
};

/** Builds deterministic Claude SDK settings for fake recovery tests. */
const fakeSettingsLayer = Layer.succeed(ClaudeAgentSdkSettings, {
  pathToClaudeCodeExecutable: Effect.sync(() => "/test/bin/claude"),
});

/** Builds the fake SDK recovery driver layer. */
const fakeRecoveryLayer = ({
  recordedRequests,
  outcomes,
  sessionIds,
}: {
  readonly recordedRequests: RecordedQueryRequest[];
  readonly outcomes: readonly (ClaudeAgentSdkQueryRuntime | ClaudeAgentSdkClientError)[];
  readonly sessionIds: readonly string[];
}) =>
  claudeAgentSdkAgentDriverRegistryLive.pipe(
    Layer.provideMerge(caaraSettingsDefaultLayer),
    Layer.provideMerge(fakeSdkClientLayer({ recordedRequests, outcomes })),
    Layer.provideMerge(fakeSessionIdLayer({ sessionIds })),
    Layer.provideMerge(fakeSettingsLayer),
    Layer.provideMerge(Path.layer),
  );

/** Builds one selected Claude target for SDK recovery tests. */
const makeTarget = ({
  rawDriverOptions = {},
}: {
  readonly rawDriverOptions?: Readonly<Record<string, string>>;
} = {}): AgentTarget =>
  new AgentTarget({
    requestedModel: "claude/sonnet",
    externalAgentKind: "claude",
    externalModelSpecifier: "sonnet",
    rawDriverOptions,
  });

/** Builds one follow-up turn with an existing durable SDK cursor. */
const makeTurn = ({
  rawDriverOptions,
}: {
  readonly rawDriverOptions?: Readonly<Record<string, string>>;
} = {}): AgentDriverTurn => ({
  codex: new CodexTurnContext({
    parentSessionId: "parent-session-sdk-recovery",
    threadId: "codex-thread-sdk-recovery",
    turnId: "turn-sdk-recovery",
    parentThreadId: "parent-thread-sdk-recovery",
    windowId: "window-sdk-recovery",
    requestKind: "turn",
    subagentKind: "caara",
    originator: "codex_cli_rs",
    requestedModel: "claude/sonnet",
    sandboxPosture: "enforced",
    workspacePaths: [projectRoot],
    cwdCandidates: [projectRoot],
  }),
  target: makeTarget({ rawDriverOptions }),
  prompt: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue from stale cursor" }],
      },
    ],
  },
  cwd: projectRoot,
  requestedCwd: undefined,
  previousTarget: makeTarget(),
  externalSession: new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor("00000000-0000-4000-8000-000000000501"),
  }),
});

/** Extracts the driver resume cursor from a durable turn result. */
const durableCursor = (result: AgentDriverTurnResult): string =>
  Match.valueTags(result.externalSession, {
    Durable: (session) => session.driverResumeCursor,
    Ephemeral: () => assert.fail("expected durable external session"),
  });

/** Starts one SDK recovery test turn through the injected fake registry. */
const runDriverTurn = Effect.fnUntraced(function* ({ turn }: { readonly turn: AgentDriverTurn }) {
  const registry = yield* AgentDriverRegistry;
  const driver = yield* registry.resolve(turn.target);
  return yield* driver.startOrResumeTurn(turn);
});

describe("Claude Agent SDK lost-session recovery", () => {
  it.effect("does not recover invalid_prompt resume query failures", () =>
    Effect.gen(function* () {
      const recordedRequests: RecordedQueryRequest[] = [];
      const layer = fakeRecoveryLayer({
        recordedRequests,
        outcomes: [
          new ClaudeAgentSdkClientError({ message: "unsupported driver option from SDK" }),
          fakeRuntime([]),
        ],
        sessionIds: ["00000000-0000-4000-8000-000000000503"],
      });
      const error = yield* runDriverTurn({ turn: makeTurn() }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      assert.strictEqual(error.responseErrorCode, "invalid_prompt");
      assert.strictEqual(error.message, "unsupported driver option from SDK");
      assert.strictEqual(recordedRequests.length, 1);
    }),
  );

  it.effect("does not recover resumed invalid driver options", () =>
    Effect.gen(function* () {
      const recordedRequests: RecordedQueryRequest[] = [];
      const layer = fakeRecoveryLayer({
        recordedRequests,
        outcomes: [fakeRuntime([])],
        sessionIds: ["00000000-0000-4000-8000-000000000504"],
      });
      const error = yield* runDriverTurn({
        turn: makeTurn({ rawDriverOptions: { "permission-mode": "auto" } }),
      }).pipe(Effect.provide(layer), Effect.flip);

      assert.strictEqual(error.responseErrorCode, "invalid_prompt");
      assert.strictEqual(
        error.message,
        "Unsupported Claude Agent SDK driver option: permission-mode.",
      );
      assert.deepStrictEqual(recordedRequests, []);
    }),
  );

  it.effect(
    "recovers a rejected resume query with a fresh SDK session and core recovery metadata",
    () =>
      Effect.gen(function* () {
        const recordedRequests: RecordedQueryRequest[] = [];
        const layer = fakeRecoveryLayer({
          recordedRequests,
          outcomes: [
            new ClaudeAgentSdkClientError({
              message:
                "No conversation found with session ID: 00000000-0000-4000-8000-000000000501",
            }),
            fakeRuntime([]),
          ],
          sessionIds: ["00000000-0000-4000-8000-000000000502"],
        });
        const turn = makeTurn();
        const result = yield* runDriverTurn({ turn }).pipe(Effect.provide(layer));
        const events = yield* result.runtimeEvents.pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk]),
        );

        assert.deepStrictEqual(events, []);
        assert.deepStrictEqual(result.lostSessionRecovery, {
          reason: "sdk-resume-query-failed",
          diagnostics: {
            message: "No conversation found with session ID: 00000000-0000-4000-8000-000000000501",
            previousCursor: "00000000-0000-4000-8000-000000000501",
          },
        });
        assert.strictEqual(durableCursor(result), "00000000-0000-4000-8000-000000000502");
        assertRequestsUseNonInteractivePermissionPolicy(recordedRequests);
        assert.deepStrictEqual(
          recordedRequests.map((request) => queryOptionsWithoutPermissionPolicy(request.options)),
          [
            {
              cwd: projectRoot,
              model: "sonnet",
              resume: "00000000-0000-4000-8000-000000000501",
              includePartialMessages: true,
            },
            {
              cwd: projectRoot,
              model: "sonnet",
              sessionId: "00000000-0000-4000-8000-000000000502",
              includePartialMessages: true,
            },
          ],
        );
      }),
  );
});
