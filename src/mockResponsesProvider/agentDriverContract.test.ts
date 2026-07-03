import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import {
  AgentDriverRegistry,
  type AgentDriver,
  type AgentDriverCancel,
  type AgentDriverResolve,
  type AgentDriverStart,
  type AgentDriverTurn,
  type AgentRuntimeEvent,
  type AgentRuntimeEventStream,
  type AgentRuntimeTerminalOutcome,
  createAssistantTextRuntimeEvents,
  createInvalidPromptAgentDriverError,
  createReasoningSummaryRuntimeEvents,
  createServerErrorAgentDriverError,
  createRuntimeTurnSucceededEvent,
} from "./agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "./codexTurnContext.ts";
import { EphemeralExternalSession } from "./sessionDirectory.ts";

/** Stable target used by the driver contract test. */
const contractTarget = new AgentTarget({
  requestedModel: "claude/contract",
  externalAgentKind: "claude",
  externalModelSpecifier: "contract",
  rawDriverOptions: {},
});

/** Stable Codex context used by the driver contract test. */
const contractCodex = new CodexTurnContext({
  parentSessionId: "parent-session-contract",
  threadId: "codex-thread-contract",
  turnId: "turn-contract",
  parentThreadId: "parent-thread-contract",
  windowId: "window-contract",
  requestKind: "turn",
  subagentKind: "caara",
  originator: "codex_cli_rs",
  requestedModel: "claude/contract",
  advisoryEffort: "high",
  sandboxPosture: "enforced",
  workspacePaths: [process.cwd()],
  cwdCandidates: [process.cwd()],
});

/** Builds one driver-facing turn using the explicit AgentDriverTurn contract. */
const contractTurn = (): AgentDriverTurn => ({
  codex: contractCodex,
  target: contractTarget,
  prompt: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "contract prompt" }],
      },
    ],
  },
  cwd: process.cwd(),
  requestedCwd: process.cwd(),
  previousTarget: undefined,
  externalSession: undefined,
});

/** Typed runtime events emitted by the contract-test driver. */
const contractRuntimeEvents: readonly AgentRuntimeEvent[] = [
  ...createReasoningSummaryRuntimeEvents({
    itemId: "contract-reasoning",
    text: "contract reasoning",
  }),
  ...createAssistantTextRuntimeEvents({
    itemId: "contract-message",
    text: "contract answer",
  }),
  createRuntimeTurnSucceededEvent(),
];

/** Contract-test stream typed through the explicit runtime stream alias. */
const contractRuntimeStream: AgentRuntimeEventStream = Stream.fromIterable(contractRuntimeEvents);

/** Contract-test cancellation hook typed through the explicit cancel alias. */
const contractCancel: AgentDriverCancel = Effect.succeed({
  _tag: "Interrupted",
  sessionReusable: true,
});

/** Contract-test start hook typed through the explicit start alias. */
const contractStart: AgentDriverStart = (turn: AgentDriverTurn) => {
  assert.strictEqual(turn.codex.advisoryEffort, "high");
  assert.strictEqual(turn.codex.sandboxPosture, "enforced");
  const externalSession = new EphemeralExternalSession();
  return Effect.succeed({
    runtimeEvents: contractRuntimeStream,
    externalSession,
    cancel: contractCancel,
  });
};

/** Contract-test driver implementation using the explicit AgentDriver interface. */
const contractDriver: AgentDriver = {
  startOrResumeTurn: contractStart,
};

/** Contract-test resolver typed through the explicit registry resolve alias. */
const contractResolve: AgentDriverResolve = Effect.fnUntraced(function* (_target: AgentTarget) {
  yield* Effect.void;
  return contractDriver;
});

/** Registry layer that forces consumers through Context service injection. */
const contractRegistryLayer = Layer.succeed(AgentDriverRegistry, {
  resolve: contractResolve,
});

describe("agent driver service contracts", () => {
  it("builds explicit Responses error-code classifications", () => {
    const surfaced = createInvalidPromptAgentDriverError({ message: "invalid option" });
    const internal = createServerErrorAgentDriverError({ message: "process crashed" });

    assert.strictEqual(surfaced.responseErrorCode, "invalid_prompt");
    assert.strictEqual(internal.responseErrorCode, "server_error");
  });

  it.effect("resolve and start through explicit Context service contracts", () =>
    Effect.gen(function* () {
      const registry = yield* AgentDriverRegistry;
      const driver = yield* registry.resolve(contractTarget);
      const result = yield* driver.startOrResumeTurn(contractTurn());
      const runtimeEvents = yield* Stream.runCollect(result.runtimeEvents);
      const cancellation = yield* result.cancel;
      const terminalOutcome: AgentRuntimeTerminalOutcome = {
        _tag: "Succeeded",
        externalSession: result.externalSession,
      };

      assert.deepStrictEqual([...runtimeEvents], contractRuntimeEvents);
      assert.deepStrictEqual(cancellation, {
        _tag: "Interrupted",
        sessionReusable: true,
      });
      assert.strictEqual(terminalOutcome._tag, "Succeeded");
    }).pipe(Effect.provide(contractRegistryLayer)),
  );

  it.effect("preserves typed driver errors in explicit runtime stream contracts", () =>
    Effect.gen(function* () {
      const failure = createInvalidPromptAgentDriverError({ message: "contract failure" });
      const failedStream: AgentRuntimeEventStream = Stream.fail(failure);
      const result = yield* Effect.result(Stream.runCollect(failedStream));

      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
