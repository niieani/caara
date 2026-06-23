import { Effect, Layer, Match, Option, Schema, Stream } from "effect";

import {
  AgentDriverError,
  AgentDriverRegistry,
  type AgentCancellationOutcome,
  type AgentDriver,
  type AgentDriverTurn,
  type AgentDriverTurnResult,
  type AgentRuntimeEvent,
  createReasoningSummaryRuntimeEvents,
  createRuntimeTurnSucceededEvent,
  unsupportedExternalAgentKindError,
} from "./agentDriver.ts";
import { createDiagnosticActivityRuntimeEventStream } from "./diagnosticDriverActivity.ts";
import { diagnosticDriverFixture } from "./diagnosticDriverFixtures.ts";
import {
  createChunkedAssistantTextRuntimeEvents,
  withConfiguredDelay,
} from "./diagnosticDriverRuntimeEvents.ts";
import {
  DurableExternalSession,
  type ExternalSessionState,
  makeDriverResumeCursor,
} from "./sessionDirectory.ts";

export { diagnosticDriverFixture } from "./diagnosticDriverFixtures.ts";

/** Driver-owned Diagnostic resume cursor schema encoded as an opaque core string. */
class DiagnosticResumeCursor extends Schema.Class<DiagnosticResumeCursor>("DiagnosticResumeCursor")(
  {
    sessionId: Schema.NonEmptyString,
  },
) {}

/** Parsed and bounded options for the diagnostic/basic scenario. */
interface DiagnosticBasicOptions {
  readonly answerText: string | undefined;
  readonly chunkCount: number;
  readonly delayMs: number;
}

/** Supported raw Diagnostic driver option names. */
const diagnosticOptionNames = [
  "diagnostic_answer_text",
  "diagnostic_chunk_count",
  "diagnostic_delay_ms",
  "diagnostic_cancel",
  "diagnostic_resume",
  "diagnostic_fresh_start",
  "diagnostic_activity",
] as const;

/** Encodes a Diagnostic session id into the driver's opaque resume cursor string. */
const encodeDiagnosticResumeCursor = (sessionId: string): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)(new DiagnosticResumeCursor({ sessionId }));

/** Decodes and validates a Diagnostic resume cursor owned by the Diagnostic driver. */
const decodeDiagnosticResumeCursor = Effect.fnUntraced(function* (driverResumeCursor: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DiagnosticResumeCursor))(
    driverResumeCursor,
  ).pipe(
    Effect.mapError(
      () => new AgentDriverError({ message: "Invalid diagnostic driver resume cursor." }),
    ),
  );
});

/** Returns the first unsupported Diagnostic raw option name, if present. */
const unsupportedDiagnosticOption = (
  rawDriverOptions: Readonly<Record<string, string>>,
): string | undefined =>
  Object.keys(rawDriverOptions).find(
    (optionName) => !diagnosticOptionNames.some((knownName) => knownName === optionName),
  );

/** Parses and bounds one optional integer driver option. */
const parseBoundedIntegerValue = Effect.fnUntraced(function* ({
  optionName,
  value,
  min,
  max,
}: {
  readonly optionName: string;
  readonly value: string;
  readonly min: number;
  readonly max: number;
}) {
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  return yield* Match.value(valid).pipe(
    Match.when(true, () => Effect.succeed(parsed)),
    Match.orElse(() =>
      Effect.fail(
        new AgentDriverError({
          message: `Diagnostic driver option ${optionName} must be an integer from ${min} to ${max}.`,
        }),
      ),
    ),
  );
});

/** Parses and bounds one optional integer driver option, falling back to a default. */
const parseBoundedIntegerOption = Effect.fnUntraced(function* ({
  rawDriverOptions,
  optionName,
  defaultValue,
  min,
  max,
}: {
  readonly rawDriverOptions: Readonly<Record<string, string>>;
  readonly optionName: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}) {
  const rawValue = rawDriverOptions[optionName];
  return yield* Option.match(Option.fromUndefinedOr(rawValue), {
    onNone: () => Effect.succeed(defaultValue),
    onSome: (value) => parseBoundedIntegerValue({ optionName, value, min, max }),
  });
});

/** Parses bounded diagnostic/basic driver options from raw provider query params. */
const parseDiagnosticBasicOptions = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  yield* Option.match(Option.fromUndefinedOr(unsupportedDiagnosticOption(rawDriverOptions)), {
    onNone: () => Effect.void,
    onSome: (optionName) =>
      Effect.fail(
        new AgentDriverError({
          message: `Unsupported diagnostic driver option: ${optionName}.`,
        }),
      ),
  });

  const chunkCount = yield* parseBoundedIntegerOption({
    rawDriverOptions,
    optionName: "diagnostic_chunk_count",
    defaultValue: 1,
    min: 1,
    max: 32,
  });
  const delayMs = yield* parseBoundedIntegerOption({
    rawDriverOptions,
    optionName: "diagnostic_delay_ms",
    defaultValue: 0,
    min: 0,
    max: 5000,
  });

  return {
    answerText: rawDriverOptions.diagnostic_answer_text,
    chunkCount,
    delayMs,
  } satisfies DiagnosticBasicOptions;
});

/** Validates that no unsupported Diagnostic driver options are present. */
const validateDiagnosticOptions = Effect.fnUntraced(function* (
  rawDriverOptions: Readonly<Record<string, string>>,
) {
  return yield* Option.match(
    Option.fromUndefinedOr(unsupportedDiagnosticOption(rawDriverOptions)),
    {
      onNone: () => Effect.void,
      onSome: (optionName) =>
        Effect.fail(
          new AgentDriverError({
            message: `Unsupported diagnostic driver option: ${optionName}.`,
          }),
        ),
    },
  );
});

/** Builds the first durable Diagnostic session for a new binding. */
const initialDiagnosticExternalSession = () =>
  new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(
      encodeDiagnosticResumeCursor(diagnosticDriverFixture.basicExternalSessionId),
    ),
  });

/** Validates an existing Diagnostic external session before reuse. */
const validateDiagnosticExternalSession = Effect.fnUntraced(function* (
  externalSession: ExternalSessionState,
) {
  return yield* Match.value(externalSession).pipe(
    Match.tags({
      Durable: (durableSession) =>
        Effect.map(
          decodeDiagnosticResumeCursor(durableSession.driverResumeCursor),
          () => durableSession,
        ),
      Ephemeral: () => Effect.succeed(externalSession),
    }),
    Match.exhaustive,
  );
});

/** Returns the durable Diagnostic session after validating an existing cursor when present. */
const diagnosticExternalSession = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  const externalSessionEffect = Option.match(Option.fromUndefinedOr(turn.externalSession), {
    onNone: () => Effect.succeed(initialDiagnosticExternalSession()),
    onSome: validateDiagnosticExternalSession,
  });
  return yield* externalSessionEffect;
});

/** Builds a fresh durable Diagnostic session after lost-continuity recovery. */
const recoveredDiagnosticExternalSession = () =>
  new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor(
      encodeDiagnosticResumeCursor(diagnosticDriverFixture.recoveredExternalSessionId),
    ),
  });

/** Extracts the previous durable Diagnostic cursor for recovery diagnostics. */
const previousDiagnosticCursor = (turn: AgentDriverTurn): string =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(
      [turn.externalSession]
        .filter((session): session is DurableExternalSession => session?._tag === "Durable")
        .map((session) => session.driverResumeCursor)
        .at(0),
    ),
  ) ?? "unknown";

/** Selects the diagnostic/basic answer text for first and resumed turns. */
const diagnosticBasicAnswerText = ({
  turn,
  options,
}: {
  readonly turn: AgentDriverTurn;
  readonly options: DiagnosticBasicOptions;
}): string =>
  Option.match(Option.fromUndefinedOr(turn.previousTarget), {
    onNone: () => options.answerText ?? diagnosticDriverFixture.basicAnswerText,
    onSome: () => diagnosticDriverFixture.resumedBasicAnswerText,
  });

/** Builds the diagnostic/basic runtime stream for a successful turn. */
const diagnosticBasicRuntimeEventStream = ({
  turn,
  options,
}: {
  readonly turn: AgentDriverTurn;
  readonly options: DiagnosticBasicOptions;
}): Stream.Stream<AgentRuntimeEvent, AgentDriverError> => {
  const answerText = diagnosticBasicAnswerText({ turn, options });
  const events = [
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.basicMessageItemId,
      text: answerText,
      chunkCount: options.chunkCount,
    }),
    createRuntimeTurnSucceededEvent(),
  ];
  return withConfiguredDelay({ events, delayMs: options.delayMs });
};

/** Builds the diagnostic/reasoning runtime stream for displayable reasoning coverage. */
const diagnosticReasoningRuntimeEventStream = (
  turn: AgentDriverTurn,
): Stream.Stream<AgentRuntimeEvent, AgentDriverError> =>
  Stream.fromIterable([
    ...createReasoningSummaryRuntimeEvents({
      itemId: diagnosticDriverFixture.reasoningItemId,
      text: diagnosticDriverFixture.reasoningText,
    }),
    ...createChunkedAssistantTextRuntimeEvents({
      itemId: diagnosticDriverFixture.basicMessageItemId,
      text: diagnosticBasicAnswerText({
        turn,
        options: {
          answerText: undefined,
          chunkCount: 1,
          delayMs: 0,
        },
      }),
      chunkCount: 1,
    }),
    createRuntimeTurnSucceededEvent(),
  ]);

/** Builds the driver error emitted by Diagnostic runtime failure streams. */
const diagnosticRuntimeFailureError = (scenario: string): AgentDriverError => {
  const message = Match.value(scenario).pipe(
    Match.when(
      "fails-after-partial",
      () => diagnosticDriverFixture.runtimeFailureAfterPartialMessage,
    ),
    Match.orElse(() => diagnosticDriverFixture.runtimeFailureBeforeOutputMessage),
  );
  return new AgentDriverError({ message });
};

/** Builds a stream that emits one partial reasoning event before failing. */
const diagnosticPartialRuntimeFailureStream = (): Stream.Stream<
  AgentRuntimeEvent,
  AgentDriverError
> =>
  Stream.concat(
    Stream.fromIterable<AgentRuntimeEvent>([
      {
        _tag: "ItemCreated",
        itemId: diagnosticDriverFixture.reasoningItemId,
        itemKind: "reasoning",
      },
      {
        _tag: "ContentStarted",
        itemId: diagnosticDriverFixture.reasoningItemId,
        contentIndex: 0,
        contentKind: "reasoning_summary_text",
      },
      {
        _tag: "ContentDelta",
        itemId: diagnosticDriverFixture.reasoningItemId,
        contentIndex: 0,
        contentKind: "reasoning_summary_text",
        text: diagnosticDriverFixture.reasoningText,
      },
    ]),
    Stream.fail(diagnosticRuntimeFailureError("fails-after-partial")),
  );

/** Returns the Diagnostic cancellation mode requested by driver options. */
const diagnosticCancellationMode = (turn: AgentDriverTurn): string =>
  turn.target.rawDriverOptions.diagnostic_cancel ?? "interrupted";

/** Builds the Diagnostic cancellation outcome for one in-flight turn. */
const diagnosticCancellationOutcome = (turn: AgentDriverTurn): AgentCancellationOutcome =>
  Match.value(diagnosticCancellationMode(turn)).pipe(
    Match.when(
      "abandoned_reusable",
      () =>
        ({
          _tag: "Abandoned",
          sessionReusable: true,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.when(
      "abandoned_nonreusable",
      () =>
        ({
          _tag: "Abandoned",
          sessionReusable: false,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.when(
      "terminated",
      () =>
        ({
          _tag: "Terminated",
          sessionReusable: false,
        }) satisfies AgentCancellationOutcome,
    ),
    Match.orElse(
      () =>
        ({
          _tag: "Interrupted",
          sessionReusable: true,
        }) satisfies AgentCancellationOutcome,
    ),
  );

/** Builds the diagnostic/basic turn result for first-turn and successful resume paths. */
const diagnosticBasicTurnResult = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  const options = yield* parseDiagnosticBasicOptions(turn.target.rawDriverOptions);
  const externalSession = yield* diagnosticExternalSession(turn);
  return {
    runtimeEvents: diagnosticBasicRuntimeEventStream({ turn, options }),
    externalSession,
    cancel: Effect.succeed(diagnosticCancellationOutcome(turn)),
  } satisfies AgentDriverTurnResult;
});

/** Builds a successful Diagnostic turn result from a scenario runtime stream. */
const diagnosticScenarioTurnResult = Effect.fnUntraced(function* ({
  turn,
  runtimeEvents,
}: {
  readonly turn: AgentDriverTurn;
  readonly runtimeEvents: Stream.Stream<AgentRuntimeEvent, AgentDriverError>;
}) {
  yield* validateDiagnosticOptions(turn.target.rawDriverOptions);
  const externalSession = yield* diagnosticExternalSession(turn);
  return {
    runtimeEvents,
    externalSession,
    cancel: Effect.succeed(diagnosticCancellationOutcome(turn)),
  } satisfies AgentDriverTurnResult;
});

/** Builds the diagnostic/activity turn result with optional Codex-visible commentary. */
const diagnosticActivityTurnResult = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  yield* validateDiagnosticOptions(turn.target.rawDriverOptions);
  const runtimeEvents = yield* createDiagnosticActivityRuntimeEventStream({
    rawDriverOptions: turn.target.rawDriverOptions,
  });
  const externalSession = yield* diagnosticExternalSession(turn);
  return {
    runtimeEvents,
    externalSession,
    cancel: Effect.succeed(diagnosticCancellationOutcome(turn)),
  } satisfies AgentDriverTurnResult;
});

/** Builds the Diagnostic recovery turn result after a failed durable resume. */
const diagnosticRecoveryTurnResult = (turn: AgentDriverTurn): AgentDriverTurnResult => ({
  runtimeEvents: Stream.empty,
  externalSession: recoveredDiagnosticExternalSession(),
  lostSessionRecovery: {
    reason: "diagnostic-unresumable-session",
    diagnostics: {
      driver: "diagnostic",
      previousCursor: previousDiagnosticCursor(turn),
    },
  },
  cancel: Effect.succeed(diagnosticCancellationOutcome(turn)),
});

/** Recovers an unresumable Diagnostic session by starting a fresh durable session when possible. */
const recoverUnresumableDiagnosticSession = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  yield* validateDiagnosticOptions(turn.target.rawDriverOptions);
  return yield* Match.value(turn.target.rawDriverOptions.diagnostic_fresh_start).pipe(
    Match.when("failure", () =>
      Effect.fail(
        new AgentDriverError({
          message: diagnosticDriverFixture.unrecoverableSessionFailureMessage,
        }),
      ),
    ),
    Match.orElse(() => Effect.succeed(diagnosticRecoveryTurnResult(turn))),
  );
});

/** Selects the Diagnostic recovery scenario behavior from explicit recovery options. */
const diagnosticRecoveryOrBasicTurnResult = (turn: AgentDriverTurn) =>
  Match.value(turn.target.rawDriverOptions.diagnostic_resume).pipe(
    Match.when("unresumable", () => recoverUnresumableDiagnosticSession(turn)),
    Match.orElse(() => diagnosticBasicTurnResult(turn)),
  );

/** Starts one Diagnostic driver turn for a supported hardcoded scenario. */
const startDiagnosticTurn = Effect.fnUntraced(function* (turn: AgentDriverTurn) {
  return yield* Match.value(turn.target.externalModelSpecifier).pipe(
    Match.when("basic", () => diagnosticBasicTurnResult(turn)),
    Match.when("reasoning", () =>
      diagnosticScenarioTurnResult({
        turn,
        runtimeEvents: diagnosticReasoningRuntimeEventStream(turn),
      }),
    ),
    Match.when("activity", () => diagnosticActivityTurnResult(turn)),
    Match.when("fails-before-output", () =>
      diagnosticScenarioTurnResult({
        turn,
        runtimeEvents: Stream.fail(diagnosticRuntimeFailureError("fails-before-output")),
      }),
    ),
    Match.when("fails-after-partial", () =>
      diagnosticScenarioTurnResult({
        turn,
        runtimeEvents: diagnosticPartialRuntimeFailureStream(),
      }),
    ),
    Match.when("hangs-until-cancel", () =>
      diagnosticScenarioTurnResult({ turn, runtimeEvents: Stream.never }),
    ),
    Match.when("recovery", () => diagnosticRecoveryOrBasicTurnResult(turn)),
    Match.orElse((scenario) =>
      Effect.fail(
        new AgentDriverError({
          message: `Unsupported diagnostic scenario: ${scenario}.`,
        }),
      ),
    ),
  );
});

/** First-class Diagnostic driver used to smoke-test Caara runtime behavior. */
export const diagnosticAgentDriver: AgentDriver = {
  startOrResumeTurn: startDiagnosticTurn,
};

/** Registry layer that routes Diagnostic targets to the Diagnostic driver. */
export const diagnosticAgentDriverRegistryLive = Layer.succeed(AgentDriverRegistry, {
  resolve: Effect.fnUntraced(function* (target) {
    return yield* Match.value(target.externalAgentKind).pipe(
      Match.when("diagnostic", () => Effect.succeed(diagnosticAgentDriver)),
      Match.orElse((externalAgentKind) =>
        Effect.fail(unsupportedExternalAgentKindError({ externalAgentKind })),
      ),
    );
  }),
});
