import { Console, Context, Effect, Layer, Schema } from "effect";

import { CaaraAppLogWriter } from "../caaraLogging.ts";

/** Effect shape returned by input logger implementations. */
export type InputLoggerEffect = ReturnType<typeof Console.log>;

/** Logs the Responses API `input` value at the provider boundary. */
export class InputLogger extends Context.Service<
  InputLogger,
  {
    readonly logInput: (input: Schema.Json) => InputLoggerEffect;
  }
>()("@caara/InputLogger") {}

/** Encodes JSON-compatible values for stdout logging. */
export const encodeInputLogLine = (input: Schema.Json): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)(input);

/** Live input logger that writes the JSON request input to stdout. */
export const inputLoggerLive = Layer.succeed(InputLogger, {
  logInput: Effect.fnUntraced(function* (input: Schema.Json) {
    yield* Console.log(encodeInputLogLine(input));
  }),
});

/** Input logger that writes to both foreground console and the app-owned JSONL log. */
export const inputLoggerWithAppLogLive = Layer.effect(
  InputLogger,
  Effect.gen(function* () {
    const appLog = yield* CaaraAppLogWriter;
    return {
      logInput: Effect.fnUntraced(function* (input: Schema.Json) {
        const line = encodeInputLogLine(input);
        yield* Effect.all([Console.log(line), appLog.writeLine(line).pipe(Effect.orDie)], {
          discard: true,
        });
      }),
    };
  }),
);
