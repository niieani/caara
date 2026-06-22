import { Effect, Option, Stream } from "effect";

import {
  buildClaudeCodePrintInvocation,
  type ClaudeCodePrintInvocationOptions,
} from "../claudeCodeContract/invocation.ts";
import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";

/** Bun subprocess handle for one Claude Code print-mode invocation. */
export type ClaudeCodeChildProcess = ReturnType<typeof Bun.spawn>;

/** Converts an unknown process or stream failure into an AgentDriverError. */
export const driverError = (cause: unknown): AgentDriverError =>
  new AgentDriverError({ message: String(cause) });

/** Spawns the Claude Code process for one prepared invocation. */
export const spawnClaudeCode = Effect.fnUntraced(function* ({
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

/** Requires a subprocess stdio handle to be a readable byte stream. */
const readableByteStream = Effect.fnUntraced(function* (value: unknown) {
  return yield* Option.match(readableByteStreamOption(value), {
    onNone: () => new AgentDriverError({ message: "Claude Code stdout is not piped." }),
    onSome: Effect.succeed,
  });
});

/** Builds a stream from one readable byte stream. */
export const stdoutStreamFromReadableStream = (
  stdout: ReadableStream<Uint8Array<ArrayBuffer>>,
): Stream.Stream<Uint8Array, AgentDriverError> =>
  Stream.fromReadableStream({
    evaluate: () => stdout,
    onError: driverError,
  });

/** Builds a stream from the child process stdout pipe. */
export const stdoutStreamFromChildProcess = (
  childProcess: ClaudeCodeChildProcess,
): Stream.Stream<Uint8Array, AgentDriverError> =>
  Option.match(readableByteStreamOption(childProcess.stdout), {
    onNone: () =>
      Stream.fail(new AgentDriverError({ message: "Claude Code stdout is not piped." })),
    onSome: stdoutStreamFromReadableStream,
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

/** Checks the process exit status after stdout has been consumed. */
export const waitForClaudeCodeExit = Effect.fnUntraced(function* ({
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

/** Minimal reader shape needed to avoid coupling to Bun's extended stream reader type. */
interface ByteStreamReader {
  readonly read: () => Promise<
    | { readonly done: true; readonly value?: Uint8Array<ArrayBuffer> }
    | { readonly done: false; readonly value: Uint8Array<ArrayBuffer> }
  >;
  readonly cancel: () => Promise<void>;
}

/** Continues first-line reading after receiving one stdout byte chunk. */
const continueFirstLineRead = ({
  reader,
  decoder,
  buffered,
  value,
}: {
  readonly reader: ByteStreamReader;
  readonly decoder: TextDecoder;
  readonly buffered: string;
  readonly value: Uint8Array<ArrayBuffer>;
}): Promise<string> => {
  const nextBuffered = `${buffered}${decoder.decode(value, { stream: true })}`;
  return Option.match(
    Option.fromUndefinedOr([nextBuffered.indexOf("\n")].filter((index) => index !== -1).at(0)),
    {
      onNone: () => readFirstLineFromReader({ reader, decoder, buffered: nextBuffered }),
      onSome: (newlineIndex) =>
        reader.cancel().then(() => nextBuffered.slice(0, newlineIndex).trim()),
    },
  );
};

/** Recursively reads one newline-delimited stdout line from a web stream reader. */
const readFirstLineFromReader = ({
  reader,
  decoder,
  buffered,
}: {
  readonly reader: ByteStreamReader;
  readonly decoder: TextDecoder;
  readonly buffered: string;
}): Promise<string> =>
  reader.read().then((result) =>
    Option.match(Option.fromUndefinedOr([result].filter((readResult) => readResult.done).at(0)), {
      onNone: () =>
        continueFirstLineRead({
          reader,
          decoder,
          buffered,
          value: Option.getOrThrow(Option.fromUndefinedOr(result.value)),
        }),
      onSome: () => Promise.resolve(`${buffered}${decoder.decode()}`.trim()),
    }),
  );

/** Reads and cancels after the first stdout line from a preview stream branch. */
export const readFirstStdoutLine = Effect.fnUntraced(function* ({
  stdout,
}: {
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>>;
}) {
  return yield* Effect.tryPromise({
    try: () =>
      readFirstLineFromReader({
        reader: stdout.getReader(),
        decoder: new TextDecoder(),
        buffered: "",
      }),
    catch: driverError,
  });
});

/** Splits a child stdout pipe into preview and runtime branches. */
export const teeChildProcessStdout = Effect.fnUntraced(function* (
  childProcess: ClaudeCodeChildProcess,
) {
  const stdout = yield* readableByteStream(childProcess.stdout);
  const [previewStdout, runtimeStdout] = stdout.tee();
  return { previewStdout, runtimeStdout } as const;
});

/** Cancels an unused readable stream branch, ignoring cleanup races. */
export const cancelReadableStream = (stream: ReadableStream<Uint8Array<ArrayBuffer>>) =>
  Effect.tryPromise({
    try: () => stream.cancel(),
    catch: driverError,
  }).pipe(Effect.ignore);
