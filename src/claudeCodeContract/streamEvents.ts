import { Effect, Match, Option, Schema } from "effect";

import {
  ClaudeCodeContractParseError,
  type ClaudeCodeAssistantMessageEvent,
  type ClaudeCodeCancellationReuseProof,
  type ClaudeCodeContractEvent,
  type ClaudeCodeInitEvent,
  type ClaudeCodeOtherEvent,
  type ClaudeCodeReasoningDeltaEvent,
  type ClaudeCodeResultEvent,
  type ClaudeCodeStreamSummary,
  type ClaudeCodeTextDeltaEvent,
  type ClaudeCodeUserMessageEvent,
} from "./streamTypes.ts";

/** Returns true when an unknown JSON value is an object record rather than an array. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads an optional string field from a decoded JSON object. */
const optionalStringField = ({
  record,
  field,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
}): string | undefined =>
  [record[field]].filter((value): value is string => typeof value === "string").at(0);

/** Reads an optional boolean field from a decoded JSON object. */
const optionalBooleanField = ({
  record,
  field,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
}): boolean | undefined =>
  [record[field]].filter((value): value is boolean => typeof value === "boolean").at(0);

/** Reads an optional object field from a decoded JSON object. */
const optionalRecordField = ({
  record,
  field,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
}): Readonly<Record<string, unknown>> | undefined => [record[field]].filter(isRecord).at(0);

/** Returns true when an unknown JSON value is an array. */
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** Reads an optional array field from a decoded JSON object. */
const optionalArrayField = ({
  record,
  field,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
}): readonly unknown[] | undefined => [record[field]].filter(isUnknownArray).at(0);

/** Reads an optional string array field from a decoded JSON object. */
const optionalStringArrayField = ({
  record,
  field,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
}): readonly string[] | undefined =>
  optionalArrayField({ record, field })?.filter((item): item is string => typeof item === "string");

/** Reads an optional array of object records from a decoded JSON object. */
const optionalRecordArrayField = ({
  record,
  field,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
}): readonly Readonly<Record<string, unknown>>[] | undefined =>
  optionalArrayField({ record, field })?.filter(isRecord);

/** Builds a typed parse error for one malformed stream-json line. */
const parseError = ({
  message,
  line,
}: {
  readonly message: string;
  readonly line: string;
}): ClaudeCodeContractParseError => new ClaudeCodeContractParseError({ message, line });

/** Requires a string field while preserving the source line in parse failures. */
const requireStringField = Effect.fnUntraced(function* ({
  record,
  field,
  line,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
  readonly line: string;
}) {
  const value = optionalStringField({ record, field });
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () =>
      parseError({
        message: `Claude Code stream event missing string field: ${field}.`,
        line,
      }),
    onSome: Effect.succeed,
  });
});

/** Requires a boolean field while preserving the source line in parse failures. */
const requireBooleanField = Effect.fnUntraced(function* ({
  record,
  field,
  line,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly field: string;
  readonly line: string;
}) {
  const value = optionalBooleanField({ record, field });
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () =>
      parseError({
        message: `Claude Code stream event missing boolean field: ${field}.`,
        line,
      }),
    onSome: Effect.succeed,
  });
});

/** Extracts visible text from Claude Code message content blocks. */
const messageTextFromContent = (message: Readonly<Record<string, unknown>>): string => {
  const content = optionalRecordArrayField({ record: message, field: "content" }) ?? [];
  return content
    .filter((item) => optionalStringField({ record: item, field: "type" }) === "text")
    .map((item) => optionalStringField({ record: item, field: "text" }) ?? "")
    .join("");
};

/** Parses a Claude Code `system/init` event into the proof subset. */
const parseInitEvent = Effect.fnUntraced(function* ({
  record,
  line,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly line: string;
}) {
  const cwd = yield* requireStringField({ record, field: "cwd", line });
  const sessionId = yield* requireStringField({ record, field: "session_id", line });
  const model = yield* requireStringField({ record, field: "model", line });
  const permissionMode = yield* requireStringField({ record, field: "permissionMode", line });
  const version = yield* requireStringField({ record, field: "claude_code_version", line });

  return {
    _tag: "Init",
    cwd,
    sessionId,
    tools: optionalStringArrayField({ record, field: "tools" }) ?? [],
    model,
    permissionMode,
    version,
  } satisfies ClaudeCodeInitEvent;
});

/** Parses a Claude Code assistant event into visible assistant text. */
const parseAssistantEvent = Effect.fnUntraced(function* ({
  record,
  line,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly line: string;
}) {
  const sessionId = yield* requireStringField({ record, field: "session_id", line });
  const message = optionalRecordField({ record, field: "message" });
  const decodedMessage = yield* Option.match(Option.fromUndefinedOr(message), {
    onNone: () =>
      parseError({
        message: "Claude Code assistant event missing message object.",
        line,
      }),
    onSome: Effect.succeed,
  });

  return {
    _tag: "AssistantMessage",
    sessionId,
    text: messageTextFromContent(decodedMessage),
  } satisfies ClaudeCodeAssistantMessageEvent;
});

/** Parses a Claude Code user event into visible user text. */
const parseUserMessageEvent = Effect.fnUntraced(function* ({
  record,
  line,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly line: string;
}) {
  const sessionId = yield* requireStringField({ record, field: "session_id", line });
  const message = optionalRecordField({ record, field: "message" });
  const decodedMessage = yield* Option.match(Option.fromUndefinedOr(message), {
    onNone: () =>
      parseError({
        message: "Claude Code user event missing message object.",
        line,
      }),
    onSome: Effect.succeed,
  });

  return {
    _tag: "UserMessage",
    sessionId,
    text: messageTextFromContent(decodedMessage),
  } satisfies ClaudeCodeUserMessageEvent;
});

/** Parses a Claude Code stream-event delta when it carries text relevant to the proof. */
const parseStreamDeltaEvent = ({
  record,
}: {
  readonly record: Readonly<Record<string, unknown>>;
}): ClaudeCodeTextDeltaEvent | ClaudeCodeReasoningDeltaEvent | ClaudeCodeOtherEvent => {
  const sessionId = optionalStringField({ record, field: "session_id" });
  const streamDeltaOption = Option.all({
    sessionId: Option.fromUndefinedOr(sessionId),
    event: Option.fromUndefinedOr(optionalRecordField({ record, field: "event" })),
  }).pipe(
    Option.flatMap(({ sessionId, event }) =>
      Option.all({
        sessionId: Option.some(sessionId),
        delta: Option.fromUndefinedOr(optionalRecordField({ record: event, field: "delta" })),
      }),
    ),
  );
  const textDeltaOption: Option.Option<ClaudeCodeTextDeltaEvent | ClaudeCodeReasoningDeltaEvent> =
    streamDeltaOption.pipe(
      Option.filter(
        ({ delta }) => optionalStringField({ record: delta, field: "type" }) === "text_delta",
      ),
      Option.flatMap(({ sessionId, delta }) =>
        Option.map(
          Option.fromUndefinedOr(optionalStringField({ record: delta, field: "text" })),
          (text) =>
            ({
              _tag: "TextDelta",
              sessionId,
              text,
            }) satisfies ClaudeCodeTextDeltaEvent,
        ),
      ),
    );
  const reasoningDeltaOption: Option.Option<
    ClaudeCodeTextDeltaEvent | ClaudeCodeReasoningDeltaEvent
  > = streamDeltaOption.pipe(
    Option.filter(
      ({ delta }) => optionalStringField({ record: delta, field: "type" }) === "thinking_delta",
    ),
    Option.flatMap(({ sessionId, delta }) =>
      Option.map(
        Option.fromUndefinedOr(optionalStringField({ record: delta, field: "thinking" })),
        (text) =>
          ({
            _tag: "ReasoningDelta",
            sessionId,
            text,
          }) satisfies ClaudeCodeReasoningDeltaEvent,
      ),
    ),
  );
  const parsedDeltaOption = Option.match(textDeltaOption, {
    onNone: () => reasoningDeltaOption,
    onSome: Option.some,
  });

  return Option.match(parsedDeltaOption, {
    onNone: () =>
      ({
        _tag: "Other",
        eventType: "stream_event",
        subtype: undefined,
        sessionId,
      }) satisfies ClaudeCodeOtherEvent,
    onSome: (event) => event,
  });
};

/** Parses a Claude Code terminal result event. */
const parseResultEvent = Effect.fnUntraced(function* ({
  record,
  line,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly line: string;
}) {
  const subtype = yield* requireStringField({ record, field: "subtype", line });
  const isError = yield* requireBooleanField({ record, field: "is_error", line });
  const sessionId = yield* requireStringField({ record, field: "session_id", line });

  return {
    _tag: "Result",
    subtype,
    isError,
    sessionId,
    resultText: optionalStringField({ record, field: "result" }),
    stopReason: optionalStringField({ record, field: "stop_reason" }),
    terminalReason: optionalStringField({ record, field: "terminal_reason" }),
    errors: optionalStringArrayField({ record, field: "errors" }) ?? [],
  } satisfies ClaudeCodeResultEvent;
});

/** Builds the generic event value for stream lines outside the current proof subset. */
const otherEventFromRecord = ({
  record,
  eventType,
  subtype,
}: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly eventType: string;
  readonly subtype: string | undefined;
}): ClaudeCodeOtherEvent => ({
  _tag: "Other",
  eventType,
  subtype,
  sessionId: optionalStringField({ record, field: "session_id" }),
});

/** Parses already-decoded JSON into the Claude Code contract event subset. */
const parseClaudeCodeStreamValue = Effect.fnUntraced(function* ({
  value,
  line,
}: {
  readonly value: unknown;
  readonly line: string;
}) {
  const record = yield* Option.match(Option.fromUndefinedOr([value].filter(isRecord).at(0)), {
    onNone: () =>
      parseError({
        message: "Claude Code stream-json line must decode to an object.",
        line,
      }),
    onSome: Effect.succeed,
  });

  const eventType = yield* requireStringField({ record, field: "type", line });
  const subtype = optionalStringField({ record, field: "subtype" });

  return yield* Match.value(eventType).pipe(
    Match.when("system", () =>
      Option.match(Option.fromUndefinedOr([subtype].filter((value) => value === "init").at(0)), {
        onNone: () => Effect.succeed(otherEventFromRecord({ record, eventType, subtype })),
        onSome: () => parseInitEvent({ record, line }),
      }),
    ),
    Match.when("assistant", () => parseAssistantEvent({ record, line })),
    Match.when("stream_event", () => Effect.succeed(parseStreamDeltaEvent({ record }))),
    Match.when("user", () => parseUserMessageEvent({ record, line })),
    Match.when("result", () => parseResultEvent({ record, line })),
    Match.orElse(() => Effect.succeed(otherEventFromRecord({ record, eventType, subtype }))),
  );
});

/** Parses one Claude Code stream-json line into the proof event subset. */
export const parseClaudeCodeStreamLine = Effect.fnUntraced(function* (line: string) {
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(line).pipe(
    Effect.mapError(() =>
      parseError({
        message: "Malformed Claude Code stream-json line.",
        line,
      }),
    ),
  );

  return yield* parseClaudeCodeStreamValue({ value, line });
});

/** Summarizes parsed Claude Code proof events into stable contract evidence. */
export const summarizeClaudeCodeEvents = (
  events: Iterable<ClaudeCodeContractEvent>,
): ClaudeCodeStreamSummary => {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let tools: readonly string[] | undefined;
  let model: string | undefined;
  let permissionMode: string | undefined;
  let version: string | undefined;
  let result: ClaudeCodeResultEvent | undefined;
  const assistantText: string[] = [];
  const textDeltas: string[] = [];
  const reasoningDeltas: string[] = [];
  const userMessages: string[] = [];

  for (const event of events) {
    Match.valueTags(event, {
      Init: (event) => {
        sessionId ??= event.sessionId;
        cwd ??= event.cwd;
        tools ??= event.tools;
        model ??= event.model;
        permissionMode ??= event.permissionMode;
        version ??= event.version;
      },
      AssistantMessage: (event) => {
        sessionId ??= event.sessionId;
        assistantText.push(event.text);
      },
      TextDelta: (event) => {
        sessionId ??= event.sessionId;
        textDeltas.push(event.text);
      },
      ReasoningDelta: (event) => {
        sessionId ??= event.sessionId;
        reasoningDeltas.push(event.text);
      },
      UserMessage: (event) => {
        sessionId ??= event.sessionId;
        userMessages.push(event.text);
      },
      Result: (event) => {
        sessionId ??= event.sessionId;
        result = event;
      },
      Other: (event) => {
        sessionId ??= event.sessionId;
      },
    });
  }

  return {
    sessionId,
    cwd,
    tools,
    model,
    permissionMode,
    version,
    assistantText: assistantText.join(""),
    textDeltas,
    reasoningDeltas,
    userMessages,
    result,
  };
};

/** Parses and summarizes Claude Code stream-json lines. */
export const summarizeClaudeCodeStream = Effect.fnUntraced(function* (lines: Iterable<string>) {
  const events = yield* Effect.forEach(lines, parseClaudeCodeStreamLine);
  return summarizeClaudeCodeEvents(events);
});

/** Infers reusable cancellation only from a failed interrupted stream and successful same-session resume. */
export const inferClaudeCodeCancellationReuse = ({
  interruptedSummary,
  resumedSummary,
}: {
  readonly interruptedSummary: ClaudeCodeStreamSummary;
  readonly resumedSummary: ClaudeCodeStreamSummary;
}): ClaudeCodeCancellationReuseProof => {
  const firstFailure = [
    {
      failed: interruptedSummary.result?.terminalReason !== "aborted_streaming",
      reason: "Interrupted stream did not end with terminal_reason=aborted_streaming.",
    },
    {
      failed: interruptedSummary.sessionId === undefined || resumedSummary.sessionId === undefined,
      reason: "Session id missing from interrupted or resumed stream.",
    },
    {
      failed: interruptedSummary.sessionId !== resumedSummary.sessionId,
      reason: "Resume probe used a different Claude Code session id.",
    },
    {
      failed: interruptedSummary.cwd === undefined || resumedSummary.cwd === undefined,
      reason: "Cwd missing from interrupted or resumed stream.",
    },
    {
      failed: interruptedSummary.cwd !== resumedSummary.cwd,
      reason: "Resume probe used a different cwd.",
    },
    {
      failed: resumedSummary.result?.isError !== false,
      reason: "Resume probe did not complete successfully.",
    },
  ].find((failure) => failure.failed);

  return Option.match(Option.fromUndefinedOr(firstFailure), {
    onNone: () => ({
      _tag: "ReusableAfterInterrupt",
      sessionId: Option.getOrThrow(Option.fromUndefinedOr(interruptedSummary.sessionId)),
    }),
    onSome: (failure) => ({
      _tag: "NotReusable",
      reason: failure.reason,
    }),
  });
};
