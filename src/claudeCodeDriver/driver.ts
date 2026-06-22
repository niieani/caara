import { randomUUID } from "node:crypto";

import { Effect, Layer, Match, Option, Result, Stream } from "effect";

import {
  buildClaudeCodePrintInvocation,
  type ClaudeCodePrintInvocationOptions,
} from "../claudeCodeContract/invocation.ts";
import { parseClaudeCodeStreamLine } from "../claudeCodeContract/streamEvents.ts";
import type { ClaudeCodeContractEvent } from "../claudeCodeContract/streamTypes.ts";
import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverTurn,
  type AgentRuntimeEvent,
} from "../mockResponsesProvider/agentDriver.ts";
import { DurableExternalSession } from "../mockResponsesProvider/sessionDirectory.ts";
import { parseClaudeCodeDriverOptions } from "./options.ts";
import { extractClaudeCodePrompt } from "./prompt.ts";

/** Bun subprocess handle for one Claude Code print-mode invocation. */
type ClaudeCodeChildProcess = ReturnType<typeof Bun.spawn>;

/** Runtime configuration for the Claude Code process driver. */
export interface ClaudeCodeAgentDriverConfig {
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Converts an unknown process or stream failure into an AgentDriverError. */
const driverError = (cause: unknown): AgentDriverError =>
  new AgentDriverError({ message: String(cause) });

/** Builds an invocation for a first-turn Claude Code session. */
const firstTurnInvocationOptions = Effect.fnUntraced(function* ({
  turn,
  prompt,
  sessionId,
}: {
  readonly turn: AgentDriverTurn;
  readonly prompt: string;
  readonly sessionId: string;
}) {
  const options = yield* parseClaudeCodeDriverOptions(turn.target.rawDriverOptions);
  return {
    cwd: turn.cwd,
    prompt,
    model: turn.target.externalModelSpecifier,
    effort: options.effort,
    maxBudgetUsd: options.maxBudgetUsd,
    tools: options.tools,
    debugFile: options.debugFile,
    includePartialMessages: options.includePartialMessages,
    sessionId,
  } satisfies ClaudeCodePrintInvocationOptions;
});

/** Spawns the Claude Code process for one prepared invocation. */
const spawnClaudeCode = Effect.fnUntraced(function* ({
  command,
  env,
  invocationOptions,
}: {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly invocationOptions: ClaudeCodePrintInvocationOptions;
}) {
  const invocation = buildClaudeCodePrintInvocation(invocationOptions);
  return yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        Bun.spawn({
          cmd: [command, ...invocation.args],
          cwd: invocation.cwd,
          env,
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
    catch: driverError,
  });
});

/** Returns true when a stdio handle is a readable byte stream. */
const isReadableByteStream = (value: unknown): value is ReadableStream<Uint8Array<ArrayBuffer>> =>
  value instanceof ReadableStream;

/** Extracts a readable byte stream from one child process stdio handle. */
const readableByteStreamOption = (
  value: unknown,
): Option.Option<ReadableStream<Uint8Array<ArrayBuffer>>> =>
  Option.fromUndefinedOr([value].filter(isReadableByteStream).at(0));

/** Builds a stream from the child process stdout pipe. */
const stdoutStreamFromChildProcess = (
  childProcess: ClaudeCodeChildProcess,
): Stream.Stream<Uint8Array, AgentDriverError> =>
  Option.match(readableByteStreamOption(childProcess.stdout), {
    onNone: () =>
      Stream.fail(new AgentDriverError({ message: "Claude Code stdout is not piped." })),
    onSome: (stdout) =>
      Stream.fromReadableStream({
        evaluate: () => stdout,
        onError: driverError,
      }),
  });

/** Reads stderr from the child process when it is piped. */
const stderrTextFromChildProcess = Effect.fnUntraced(function* (
  childProcess: ClaudeCodeChildProcess,
) {
  return yield* Option.match(readableByteStreamOption(childProcess.stderr), {
    onNone: () => new AgentDriverError({ message: "Claude Code stderr is not piped." }),
    onSome: (stderr) =>
      Effect.tryPromise({
        try: () => new Response(stderr).text(),
        catch: driverError,
      }),
  });
});

/** Converts one Claude Code event into a normalized Caara runtime event when applicable. */
const runtimeEventResult = (event: AgentRuntimeEvent): Result.Result<AgentRuntimeEvent, void> =>
  Result.succeed(event);

/** Result marker used by Stream.filterMapEffect to skip non-runtime Claude events. */
const skippedRuntimeEvent = (): Result.Result<AgentRuntimeEvent, void> => Result.fail(undefined);

/** Converts an optional runtime event into the Result shape expected by Stream.filterMapEffect. */
const runtimeEventResultFromOption = (
  event: Option.Option<AgentRuntimeEvent>,
): Result.Result<AgentRuntimeEvent, void> => Result.fromOption(event, () => undefined);

/** Converts one Claude Code event into a normalized Caara runtime event when applicable. */
const runtimeEventFromClaudeEvent = Effect.fnUntraced(function* (event: ClaudeCodeContractEvent) {
  return yield* Match.valueTags(event, {
    AssistantMessage: (event) =>
      Effect.succeed(
        runtimeEventResultFromOption(
          Option.fromUndefinedOr(
            [event.text]
              .filter((text) => text.length > 0)
              .map(
                (text) =>
                  ({
                    _tag: "AssistantMessage",
                    text,
                  }) satisfies AgentRuntimeEvent,
              )
              .at(0),
          ),
        ),
      ),
    TextDelta: (event) =>
      Effect.succeed(
        runtimeEventResult({
          _tag: "AssistantMessage",
          text: event.text,
        } satisfies AgentRuntimeEvent),
      ),
    ReasoningDelta: (event) =>
      Effect.succeed(
        runtimeEventResult({
          _tag: "ReasoningDelta",
          text: event.text,
        } satisfies AgentRuntimeEvent),
      ),
    Result: (event) =>
      Option.match(Option.fromUndefinedOr([event].filter((result) => result.isError).at(0)), {
        onNone: () => Effect.succeed(skippedRuntimeEvent()),
        onSome: (result) =>
          new AgentDriverError({
            message: result.resultText ?? `Claude Code failed with subtype ${result.subtype}.`,
          }),
      }),
    Init: () => Effect.succeed(skippedRuntimeEvent()),
    UserMessage: () => Effect.succeed(skippedRuntimeEvent()),
    Other: () => Effect.succeed(skippedRuntimeEvent()),
  });
});

/** Parses one Claude Code stdout line and maps parse failures to driver failures. */
const parseClaudeCodeDriverStreamLine = Effect.fnUntraced(function* (line: string) {
  return yield* parseClaudeCodeStreamLine(line).pipe(
    Effect.mapError((error) => new AgentDriverError({ message: error.message })),
  );
});

/** Checks the process exit status after stdout has been consumed. */
const waitForClaudeCodeExit = Effect.fnUntraced(function* ({
  childProcess,
}: {
  readonly childProcess: ClaudeCodeChildProcess;
}) {
  const stderr = yield* stderrTextFromChildProcess(childProcess);
  const exitCode = yield* Effect.tryPromise({
    try: () => childProcess.exited,
    catch: driverError,
  });
  return yield* Option.match(
    Option.fromUndefinedOr([exitCode].filter((code) => code !== 0).at(0)),
    {
      onNone: () => Effect.void,
      onSome: (code) =>
        new AgentDriverError({
          message: `Claude Code exited with code ${code}: ${stderr}`,
        }),
    },
  );
});

/** Builds the runtime event stream from one Claude Code child process stdout. */
const runtimeEventsFromClaudeProcess = ({
  childProcess,
}: {
  readonly childProcess: ClaudeCodeChildProcess;
}): Stream.Stream<AgentRuntimeEvent, AgentDriverError> => {
  const stdoutEvents = stdoutStreamFromChildProcess(childProcess).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.mapEffect(parseClaudeCodeDriverStreamLine),
    Stream.filterMapEffect(runtimeEventFromClaudeEvent),
  );
  const exitCheck = Stream.fromEffect(waitForClaudeCodeExit({ childProcess })).pipe(Stream.drain);

  return stdoutEvents.pipe(Stream.concat(exitCheck));
};

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
    const sessionId = randomUUID();
    const invocationOptions = yield* firstTurnInvocationOptions({ turn, prompt, sessionId });
    const childProcess = yield* spawnClaudeCode({ command, env, invocationOptions });

    return {
      runtimeEvents: runtimeEventsFromClaudeProcess({ childProcess }),
      externalSession: new DurableExternalSession({ externalSessionId: sessionId }),
      cancel: Effect.fnUntraced(function* () {
        yield* Effect.sync(() => childProcess.kill("SIGINT"));
        return {
          _tag: "Interrupted",
          sessionReusable: true,
        } satisfies AgentCancellationOutcome;
      }),
    };
  }),
});

/** Live registry layer that routes Claude targets to the real Claude Code process driver. */
export const claudeCodeAgentDriverRegistryLive = ({
  command = "claude",
  env = process.env,
}: ClaudeCodeAgentDriverConfig = {}) =>
  Layer.succeed(AgentDriverRegistry, {
    resolve: () => Effect.succeed(createClaudeCodeAgentDriver({ command, env })),
  });
