import { randomUUID } from "node:crypto";

import { Effect, Layer, Match, Option, Result, Stream } from "effect";

import type { ClaudeCodePrintInvocationOptions } from "../claudeCodeContract/invocation.ts";
import { parseClaudeCodeStreamLine } from "../claudeCodeContract/streamEvents.ts";
import type { ClaudeCodeContractEvent } from "../claudeCodeContract/streamTypes.ts";
import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentRuntimeEvent,
  createAssistantTextRuntimeEvents,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
  unsupportedExternalAgentKindError,
} from "../mockResponsesProvider/agentDriver.ts";
import {
  DurableExternalSession,
  makeDriverResumeCursor,
} from "../mockResponsesProvider/sessionDirectory.ts";
import { lostSessionRecoveryAssistantText } from "../mockResponsesProvider/sessionRecoveryPolicy.ts";
import { parseClaudeCodeDriverOptions } from "./options.ts";
import {
  cancelReadableStream,
  type ClaudeCodeChildProcess,
  driverError,
  readFirstStdoutLine,
  spawnClaudeCode,
  stdoutStreamFromChildProcess,
  stdoutStreamFromReadableStream,
  teeChildProcessStdout,
  waitForClaudeCodeExit,
} from "./process.ts";
import { extractClaudeCodePrompt } from "./prompt.ts";

/** Runtime configuration for the Claude Code process driver. */
export interface ClaudeCodeAgentDriverConfig {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Extracts a durable Claude session id from prior external session state. */
const durableSessionIdOption = (turn: AgentDriverTurn): Option.Option<string> =>
  Option.fromUndefinedOr(
    [turn.externalSession]
      .filter((session): session is DurableExternalSession => session?._tag === "Durable")
      .map((session) => session.driverResumeCursor)
      .at(0),
  );

/** Builds an invocation for a first or resumed Claude Code session. */
const turnInvocationOptions = Effect.fnUntraced(function* ({
  turn,
  prompt,
  sessionId,
  resumeSessionId,
}: {
  readonly turn: AgentDriverTurn;
  readonly prompt: string;
  readonly sessionId: string;
  readonly resumeSessionId: string | undefined;
}) {
  const options = yield* parseClaudeCodeDriverOptions(turn.target.rawDriverOptions);
  const newSessionId = Option.match(Option.fromUndefinedOr(resumeSessionId), {
    onNone: () => sessionId,
    onSome: () => undefined,
  });
  return {
    cwd: turn.cwd,
    prompt,
    model: turn.target.externalModelSpecifier,
    effort: options.effort,
    maxBudgetUsd: options.maxBudgetUsd,
    tools: options.tools,
    debugFile: options.debugFile,
    includePartialMessages: options.includePartialMessages,
    sessionId: newSessionId,
    resumeSessionId,
  } satisfies ClaudeCodePrintInvocationOptions;
});

/** Stateful Claude stdout-to-runtime lifecycle conversion position. */
interface ClaudeRuntimeEventState {
  readonly nextItemIndex: number;
}

/** Builds a stable runtime item id for one Claude stdout-derived output item. */
const claudeRuntimeItemId = ({
  state,
  prefix,
}: {
  readonly state: ClaudeRuntimeEventState;
  readonly prefix: string;
}): string => `${prefix}-${state.nextItemIndex}`;

/** Advances the Claude runtime item counter after emitting one output item lifecycle. */
const nextClaudeRuntimeEventState = (state: ClaudeRuntimeEventState): ClaudeRuntimeEventState => ({
  nextItemIndex: state.nextItemIndex + 1,
});

/** Converts one Claude Code event into zero or more normalized Caara runtime events. */
const runtimeEventsFromClaudeEvent = Effect.fnUntraced(function* ({
  state,
  event,
}: {
  readonly state: ClaudeRuntimeEventState;
  readonly event: ClaudeCodeContractEvent;
}) {
  return yield* Match.valueTags(event, {
    AssistantMessage: (event) =>
      Effect.succeed(
        Option.match(Option.fromUndefinedOr([event.text].filter((text) => text.length > 0).at(0)), {
          onNone: () => [state, []] as const,
          onSome: (text) =>
            [
              nextClaudeRuntimeEventState(state),
              createAssistantTextRuntimeEvents({
                itemId: claudeRuntimeItemId({ state, prefix: "claude-message" }),
                text,
              }),
            ] as const,
        }),
      ),
    TextDelta: (event) =>
      Effect.succeed([
        nextClaudeRuntimeEventState(state),
        createAssistantTextRuntimeEvents({
          itemId: claudeRuntimeItemId({ state, prefix: "claude-message" }),
          text: event.text,
        }),
      ] as const),
    ReasoningDelta: (event) =>
      Effect.succeed([
        nextClaudeRuntimeEventState(state),
        createReasoningSummaryRuntimeEvents({
          itemId: claudeRuntimeItemId({ state, prefix: "claude-reasoning" }),
          text: event.text,
        }),
      ] as const),
    Result: (event) =>
      Option.match(Option.fromUndefinedOr([event].filter((result) => result.isError).at(0)), {
        onNone: () => Effect.succeed([state, [createRuntimeTurnSucceededEvent()]] as const),
        onSome: (result) =>
          new AgentDriverError({
            message: result.resultText ?? `Claude Code failed with subtype ${result.subtype}.`,
          }),
      }),
    Init: () => Effect.succeed([state, []] as const),
    UserMessage: () => Effect.succeed([state, []] as const),
    Other: () => Effect.succeed([state, []] as const),
  });
});

/** Parses one Claude Code stdout line and maps parse failures to driver failures. */
const parseClaudeCodeDriverStreamLine = Effect.fnUntraced(function* (line: string) {
  return yield* parseClaudeCodeStreamLine(line).pipe(
    Effect.mapError((error) => new AgentDriverError({ message: error.message })),
  );
});

/** Formats a Claude Code terminal result into a driver-facing failure message. */
const failureMessageFromClaudeResult = (
  result: Extract<ClaudeCodeContractEvent, { readonly _tag: "Result" }>,
): string =>
  result.resultText ?? result.errors.at(0) ?? `Claude Code failed with subtype ${result.subtype}.`;

/** Returns true when Claude reports that the stored session id cannot be resumed. */
const isUnresumableClaudeSessionResult = (
  event: ClaudeCodeContractEvent,
): event is Extract<ClaudeCodeContractEvent, { readonly _tag: "Result" }> =>
  event._tag === "Result" &&
  event.isError &&
  [event.resultText, ...event.errors]
    .filter((message): message is string => message !== undefined)
    .some((message) => /No conversation found with session ID/i.test(message));

/** Finds the first terminal Claude failure in a collected process event list. */
const failedClaudeResultOption = (
  events: readonly ClaudeCodeContractEvent[],
): Option.Option<Extract<ClaudeCodeContractEvent, { readonly _tag: "Result" }>> =>
  Option.fromUndefinedOr(
    events
      .filter(
        (event): event is Extract<ClaudeCodeContractEvent, { readonly _tag: "Result" }> =>
          event._tag === "Result" && event.isError,
      )
      .at(0),
  );

/** Drains a Claude process into parsed events and fails on terminal process failure. */
const collectClaudeCodeEvents = Effect.fnUntraced(function* ({
  childProcess,
}: {
  readonly childProcess: ClaudeCodeChildProcess;
}) {
  const events = yield* stdoutStreamFromChildProcess(childProcess).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.mapEffect(parseClaudeCodeDriverStreamLine),
    Stream.runCollect,
    Effect.map((collected) => [...collected]),
  );
  const exitResult = yield* Effect.result(waitForClaudeCodeExit({ childProcess }));
  const failedResult = failedClaudeResultOption(events);

  return yield* Option.match(failedResult, {
    onNone: () =>
      Result.match(exitResult, {
        onFailure: (error) => Effect.fail(error),
        onSuccess: () => Effect.succeed(events),
      }),
    onSome: (result) =>
      Effect.fail(new AgentDriverError({ message: failureMessageFromClaudeResult(result) })),
  });
});

/** Builds the runtime event stream from one Claude Code child process stdout. */
const runtimeEventsFromClaudeProcess = ({
  childProcess,
  stdout,
}: {
  readonly childProcess: ClaudeCodeChildProcess;
  readonly stdout?: ReadableStream<Uint8Array<ArrayBuffer>>;
}): Stream.Stream<AgentRuntimeEvent, AgentDriverError> => {
  const stdoutStream = Option.match(Option.fromUndefinedOr(stdout), {
    onNone: () => stdoutStreamFromChildProcess(childProcess),
    onSome: stdoutStreamFromReadableStream,
  });
  const stdoutEvents = stdoutStream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.mapEffect(parseClaudeCodeDriverStreamLine),
    Stream.mapAccumEffect(
      () => ({ nextItemIndex: 0 }) satisfies ClaudeRuntimeEventState,
      (state, event) => runtimeEventsFromClaudeEvent({ state, event }),
    ),
  );
  const exitCheck = Stream.fromEffect(waitForClaudeCodeExit({ childProcess })).pipe(Stream.drain);

  return stdoutEvents.pipe(Stream.concat(exitCheck));
};

/** Builds the prompt used to create a fresh recovery session after failed resume. */
const recoveryPrompt = (): string =>
  `Reply with exactly this text and nothing else:\n\n${lostSessionRecoveryAssistantText}`;

/** Builds a reusable turn result around one live Claude process. */
const claudeProcessTurnResult = ({
  childProcess,
  stdout,
  sessionId,
}: {
  readonly childProcess: ClaudeCodeChildProcess;
  readonly stdout?: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly sessionId: string;
}): AgentDriverTurnResult => ({
  runtimeEvents: runtimeEventsFromClaudeProcess({ childProcess, stdout }),
  externalSession: new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(sessionId),
  }),
  cancel: Effect.gen(function* () {
    yield* Effect.sync(() => childProcess.kill("SIGINT"));
    const exitResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => childProcess.exited,
        catch: driverError,
      }).pipe(Effect.timeoutOption("1 second")),
    );

    return Result.match(exitResult, {
      onFailure: () =>
        ({
          _tag: "Terminated",
          sessionReusable: false,
        }) satisfies AgentCancellationOutcome,
      onSuccess: (exitOption) =>
        Option.match(exitOption, {
          onNone: () =>
            ({
              _tag: "Abandoned",
              sessionReusable: false,
            }) satisfies AgentCancellationOutcome,
          onSome: () =>
            ({
              _tag: "Interrupted",
              sessionReusable: true,
            }) satisfies AgentCancellationOutcome,
        }),
    });
  }),
});

/** Builds a completed recovery reply after a fresh Claude session has been created. */
const recoveredClaudeTurnResult = ({
  sessionId,
}: {
  readonly sessionId: string;
}): AgentDriverTurnResult => ({
  runtimeEvents: Stream.fromIterable([
    ...createAssistantTextRuntimeEvents({
      itemId: "claude-recovery-message",
      text: lostSessionRecoveryAssistantText,
    }),
    createRuntimeTurnSucceededEvent(),
  ]),
  externalSession: new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(sessionId),
  }),
  cancel: Effect.gen(function* () {
    yield* Effect.void;
    return {
      _tag: "Interrupted",
      sessionReusable: true,
    } satisfies AgentCancellationOutcome;
  }),
});

/** Starts a fresh Claude session and returns the canonical lost-context recovery reply. */
const recoverUnresumableClaudeSession = Effect.fnUntraced(function* ({
  turn,
  command,
  env,
}: {
  readonly turn: AgentDriverTurn;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const recoverySessionId = randomUUID();
  const invocationOptions = yield* turnInvocationOptions({
    turn,
    prompt: recoveryPrompt(),
    sessionId: recoverySessionId,
    resumeSessionId: undefined,
  });
  const childProcess = yield* spawnClaudeCode({ command, env, invocationOptions });
  const freshStartResult = yield* Effect.result(collectClaudeCodeEvents({ childProcess }));

  return yield* Result.match(freshStartResult, {
    onFailure: (error) =>
      Effect.fail(
        new AgentDriverError({
          message: `Claude Code could not resume prior session or start a fresh external session: ${error.message}`,
        }),
      ),
    onSuccess: () => Effect.succeed(recoveredClaudeTurnResult({ sessionId: recoverySessionId })),
  });
});

/** Starts a resumed Claude turn, falling back to fresh-session recovery on missing sessions. */
const startResumedClaudeTurn = Effect.fnUntraced(function* ({
  turn,
  command,
  env,
  prompt,
  sessionId,
}: {
  readonly turn: AgentDriverTurn;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly sessionId: string;
}) {
  const invocationOptions = yield* turnInvocationOptions({
    turn,
    prompt,
    sessionId,
    resumeSessionId: sessionId,
  });
  const childProcess = yield* spawnClaudeCode({ command, env, invocationOptions });
  const { previewStdout, runtimeStdout } = yield* teeChildProcessStdout(childProcess);
  const firstLine = yield* readFirstStdoutLine({ stdout: previewStdout });
  const firstEvent = yield* parseClaudeCodeDriverStreamLine(firstLine);

  return yield* Option.match(
    Option.fromUndefinedOr([firstEvent].filter(isUnresumableClaudeSessionResult).at(0)),
    {
      onNone: () =>
        Effect.succeed(claudeProcessTurnResult({ childProcess, stdout: runtimeStdout, sessionId })),
      onSome: () =>
        Effect.gen(function* () {
          yield* cancelReadableStream(runtimeStdout);
          yield* Effect.result(waitForClaudeCodeExit({ childProcess }));
          return yield* recoverUnresumableClaudeSession({ turn, command, env });
        }),
    },
  );
});

/** Builds a Claude Code agent driver for one process configuration. */
const createClaudeCodeAgentDriver = ({
  command,
  env,
}: {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}): AgentDriver => ({
  startOrResumeTurn: Effect.fnUntraced(function* (turn: AgentDriverTurn) {
    const prompt = yield* extractClaudeCodePrompt(turn.prompt.input);
    const resumeSessionId = Option.getOrUndefined(durableSessionIdOption(turn));
    const sessionId = Option.match(Option.fromUndefinedOr(resumeSessionId), {
      onNone: () => randomUUID(),
      onSome: (existingSessionId) => existingSessionId,
    });
    return yield* Option.match(Option.fromUndefinedOr(resumeSessionId), {
      onNone: () =>
        Effect.gen(function* () {
          const invocationOptions = yield* turnInvocationOptions({
            turn,
            prompt,
            sessionId,
            resumeSessionId,
          });
          const childProcess = yield* spawnClaudeCode({ command, env, invocationOptions });
          return claudeProcessTurnResult({ childProcess, sessionId });
        }),
      onSome: () => startResumedClaudeTurn({ turn, command, env, prompt, sessionId }),
    });
  }),
});

/** Live registry layer that routes Claude targets to the real Claude Code process driver. */
export const claudeCodeAgentDriverRegistryLive = ({
  command = "claude",
  env = process.env,
}: ClaudeCodeAgentDriverConfig = {}) =>
  Layer.succeed(AgentDriverRegistry, {
    resolve: Effect.fnUntraced(function* (target) {
      return yield* Match.value(target.externalAgentKind).pipe(
        Match.when("claude", () => Effect.succeed(createClaudeCodeAgentDriver({ command, env }))),
        Match.orElse((externalAgentKind) =>
          Effect.fail(unsupportedExternalAgentKindError({ externalAgentKind })),
        ),
      );
    }),
  });
