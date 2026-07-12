import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Stream } from "effect";

import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";
import { AgentTarget } from "../mockResponsesProvider/codexTurnContext.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import {
  createCodexCliAgentDriver,
  type CodexCliClient,
  type CodexCliInvocation,
} from "./driver.ts";

/** Builds one portable Codex driver turn with explicit lineage metadata. */
const turn = ({
  metadata = {},
  externalSession,
}: {
  readonly metadata?: Readonly<Record<string, string>>;
  readonly externalSession?: DurableExternalSession;
}) => ({
  context: {
    identity: { sessionId: "portable-session", parentSessionId: "parent", turnId: "turn" },
    origin: { transport: "cli", metadata },
    advisories: { effort: "high" as const, sandboxPosture: "enforced" as const },
    requestedCwd: "/workspace",
  },
  target: new AgentTarget({
    requestedModel: "codex/gpt-5.6",
    externalAgentKind: "codex",
    externalModelSpecifier: "gpt-5.6",
    rawDriverOptions: {},
  }),
  prompt: {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "delegate" }] }],
  },
  cwd: "/workspace",
  requestedCwd: "/workspace",
  previousTarget: undefined,
  externalSession,
});

/** Creates a recording Codex harness with normalized activity and cancellation. */
const recordingClient = ({
  invocations,
}: {
  readonly invocations: CodexCliInvocation[];
}): CodexCliClient => ({
  start: (invocation) => {
    invocations.push(invocation);
    return Effect.succeed({
      sessionId: invocation.resumeSessionId ?? "codex-session-new",
      runtimeEvents: Stream.fromIterable([
        { _tag: "Reasoning", text: "private visible reasoning" } as const,
        { _tag: "Assistant", text: "final from Codex" } as const,
        { _tag: "Succeeded" } as const,
      ]),
      cancel: Effect.succeed({ _tag: "Terminated", sessionReusable: false } as const),
    });
  },
});

describe("Codex CLI Agent driver", () => {
  it.effect("starts, normalizes viewer activity, emits a final answer, and cancels", () =>
    Effect.gen(function* () {
      const invocations: CodexCliInvocation[] = [];
      const driver = createCodexCliAgentDriver({
        client: recordingClient({ invocations }),
        maximumDepth: 3,
      });
      const result = yield* driver.startOrResumeTurn(
        turn({ metadata: { caaraLineage: "claude-root", caaraDepth: "1" } }),
      );
      const events = yield* Stream.runCollect(result.runtimeEvents);

      assert.strictEqual(invocations.length, 1);
      assert.deepStrictEqual(invocations[0]?.lineage, ["claude-root", "codex"]);
      assert.strictEqual(invocations[0]?.depth, 2);
      assert.match(invocations[0]?.prompt ?? "", /caaraLineage=claude-root,codex/u);
      assert.match(invocations[0]?.prompt ?? "", /caaraDepth=2/u);
      assert.ok(result.externalSession instanceof DurableExternalSession);
      assert.strictEqual(result.externalSession.driverResumeCursor, "codex-session-new");
      assert.deepStrictEqual(result.externalSession.delegationLineage, ["claude-root"]);
      assert.strictEqual(result.externalSession.delegationDepth, 1);
      assert.deepStrictEqual(
        [...events].map(({ _tag }) => _tag),
        [
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "ItemCreated",
          "ContentStarted",
          "ContentDelta",
          "ContentCompleted",
          "ItemCompleted",
          "TurnSucceeded",
        ],
      );
      const deltas = [...events]
        .filter((event) => event._tag === "ContentDelta")
        .map(({ text }) => text);
      assert.deepStrictEqual(deltas, ["private visible reasoning", "final from Codex"]);
      assert.deepStrictEqual(yield* result.cancel, { _tag: "Terminated", sessionReusable: false });
    }),
  );

  it.effect("resumes a durable Codex session", () =>
    Effect.gen(function* () {
      const invocations: CodexCliInvocation[] = [];
      const driver = createCodexCliAgentDriver({
        client: recordingClient({ invocations }),
        maximumDepth: 3,
      });
      yield* driver.startOrResumeTurn(
        turn({
          externalSession: new DurableExternalSession({
            driverResumeCursor: makeDriverResumeCursor("codex-session-existing"),
          }),
        }),
      );
      assert.strictEqual(invocations[0]?.resumeSessionId, "codex-session-existing");
    }),
  );

  it.effect("rejects same-lineage recursion and excessive depth before starting Codex", () =>
    Effect.gen(function* () {
      for (const metadata of [
        { caaraLineage: "claude-root,codex", caaraDepth: "1" },
        { caaraLineage: "claude-root", caaraDepth: "3" },
      ]) {
        const invocations: CodexCliInvocation[] = [];
        const driver = createCodexCliAgentDriver({
          client: recordingClient({ invocations }),
          maximumDepth: 3,
        });
        const outcome = yield* Effect.result(driver.startOrResumeTurn(turn({ metadata })));
        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual(invocations.length, 0);
      }
    }),
  );

  it.effect("resumes the durable session while preserving its pre-driver lineage", () =>
    Effect.gen(function* () {
      const invocations: CodexCliInvocation[] = [];
      const driver = createCodexCliAgentDriver({
        client: recordingClient({ invocations }),
        maximumDepth: 3,
      });
      const first = yield* driver.startOrResumeTurn(
        turn({ metadata: { caaraLineage: "claude-root", caaraDepth: "1" } }),
      );
      assert.ok(first.externalSession instanceof DurableExternalSession);
      yield* driver.startOrResumeTurn(
        turn({ metadata: {}, externalSession: first.externalSession }),
      );
      assert.strictEqual(invocations.length, 2);
      assert.strictEqual(invocations[1]?.resumeSessionId, "codex-session-new");
      assert.deepStrictEqual(invocations[1]?.lineage, ["claude-root", "codex"]);
      assert.strictEqual(invocations[1]?.depth, 2);
    }),
  );

  it.effect("recovers an unavailable durable Codex session with explicit diagnostics", () =>
    Effect.gen(function* () {
      const invocations: CodexCliInvocation[] = [];
      const fallback = recordingClient({ invocations });
      const client: CodexCliClient = {
        start: (invocation) =>
          Match.value(invocation.resumeSessionId).pipe(
            Match.when(undefined, () => fallback.start(invocation)),
            Match.orElse(() => {
              invocations.push(invocation);
              return Effect.fail(
                new AgentDriverError({
                  message: "Codex resume session not found.",
                  responseErrorCode: "server_error",
                }),
              );
            }),
          ),
      };
      const driver = createCodexCliAgentDriver({ client, maximumDepth: 3 });
      const result = yield* driver.startOrResumeTurn(
        turn({
          externalSession: new DurableExternalSession({
            driverResumeCursor: makeDriverResumeCursor("lost-codex-session"),
          }),
        }),
      );
      assert.strictEqual(invocations.length, 2);
      assert.strictEqual(result.lostSessionRecovery?.reason, "codex-resume-unavailable");
    }),
  );
});
