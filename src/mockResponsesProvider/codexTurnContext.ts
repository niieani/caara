import { Effect, Match, Option, Schema } from "effect";
import * as Path from "effect/Path";

import { InvalidResponsesRequest } from "./errors.ts";
import { decodeResponsesCreateRequest, type ResponsesCreateRequest } from "./protocol.ts";
import { extractCwdCandidates } from "./requestDiagnosticsLogger.ts";

/** Open external agent kind syntax accepted before registry-owned availability checks. */
const externalAgentKindPattern = /^[a-z][a-z0-9-]*$/u;

/** Metadata for one workspace path observed in Codex turn metadata. */
const codexWorkspaceMetadataSchema = Schema.Struct({
  latest_git_commit_hash: Schema.String,
  has_changes: Schema.Boolean,
});

/** Raw `x-codex-turn-metadata` object decoded from the Codex header. */
const codexTurnMetadataSchema = Schema.Struct({
  installation_id: Schema.String,
  session_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
  window_id: Schema.String,
  request_kind: Schema.Literal("turn"),
  parent_thread_id: Schema.String,
  subagent_kind: Schema.String,
  sandbox: Schema.String,
  workspaces: Schema.optional(Schema.Record(Schema.String, codexWorkspaceMetadataSchema)),
  turn_started_at_unix_ms: Schema.Finite,
});

/** Codex-provided reasoning effort values accepted as advisory driver input. */
const codexAdvisoryEffortSchema = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
]);

/** Coarse Codex sandbox posture exposed to drivers as advisory input. */
const codexSandboxPostureSchema = Schema.Union([
  Schema.Literal("none"),
  Schema.Literal("enforced"),
]);

/** Optional body-level Codex reasoning advisory shape. */
const codexBodyReasoningSchema = Schema.Struct({
  effort: Schema.optional(codexAdvisoryEffortSchema),
});

/** Codex advisory reasoning effort available to driver-specific fallback mapping. */
export type CodexAdvisoryEffort = typeof codexAdvisoryEffortSchema.Type;

/** Coarse Codex sandbox posture available to driver-specific fallback mapping. */
export type CodexSandboxPosture = typeof codexSandboxPostureSchema.Type;

/** Raw Codex identity headers required before Caara can bind a turn to a session. */
const codexRequestHeadersSchema = Schema.Struct({
  "session-id": Schema.String,
  "thread-id": Schema.String,
  "x-client-request-id": Schema.String,
  "x-codex-parent-thread-id": Schema.String,
  "x-codex-turn-metadata": Schema.String,
  "x-codex-window-id": Schema.String,
  "x-openai-subagent": Schema.String,
  originator: Schema.String,
});

/** Optional body-level Codex metadata duplicated by the Responses request body. */
const codexBodyClientMetadataSchema = Schema.Struct({
  thread_id: Schema.optional(Schema.String),
  turn_id: Schema.optional(Schema.String),
});

/** Validated Codex identity and workspace context for one turn. */
export class CodexTurnContext extends Schema.Class<CodexTurnContext>("CodexTurnContext")({
  parentSessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  parentThreadId: Schema.String,
  windowId: Schema.String,
  requestKind: Schema.Literal("turn"),
  subagentKind: Schema.String,
  originator: Schema.String,
  requestedModel: Schema.String,
  advisoryEffort: Schema.optional(codexAdvisoryEffortSchema),
  sandboxPosture: codexSandboxPostureSchema,
  workspacePaths: Schema.Array(Schema.String),
  cwdCandidates: Schema.Array(Schema.String),
}) {}

/** Resolved target selected from the Responses request model and provider query params. */
export class AgentTarget extends Schema.Class<AgentTarget>("AgentTarget")({
  requestedModel: Schema.String,
  externalAgentKind: Schema.String,
  externalModelSpecifier: Schema.String,
  rawDriverOptions: Schema.Record(Schema.String, Schema.String),
}) {}

/** Validated transport-edge request shape passed to later driver/session layers. */
export interface DecodedCodexTurnRequest {
  readonly responses: ResponsesCreateRequest;
  readonly codex: CodexTurnContext;
  readonly target: AgentTarget;
}

/** Input data needed to validate one Codex-shaped Responses request at the transport edge. */
export interface DecodeCodexTurnRequestOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
  readonly body: Schema.Json;
  readonly requireCwd: boolean;
}

/** Creates a validation failure with the OpenAI-compatible invalid request error tag. */
const invalidRequest = (message: string): InvalidResponsesRequest =>
  new InvalidResponsesRequest({ message });

/** Lowercases HTTP header names so Codex identity validation is case-insensitive. */
const normalizeHeaders = (
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const normalizedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalizedHeaders[name.toLowerCase()] = value;
  }
  return normalizedHeaders;
};

/** Returns true when a JSON value is an object record rather than an array. */
const isJsonRecord = (value: Schema.Json): value is Readonly<Record<string, Schema.Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extracts optional body `client_metadata` without treating absence as malformed input. */
const bodyClientMetadataOption = (body: Schema.Json): Option.Option<Schema.Json> =>
  Option.fromUndefinedOr(
    [body]
      .filter(isJsonRecord)
      .map((record) => record.client_metadata)
      .at(0),
  );

/** Extracts optional body `reasoning` without treating absence as malformed input. */
const bodyReasoningOption = (body: Schema.Json): Option.Option<Schema.Json> =>
  Option.fromUndefinedOr(
    [body]
      .filter(isJsonRecord)
      .map((record) => record.reasoning)
      .at(0),
  );

/** Decodes required Codex headers into their typed validation shape. */
const decodeCodexHeaders = Effect.fnUntraced(function* (headers: Readonly<Record<string, string>>) {
  return yield* Schema.decodeUnknownEffect(codexRequestHeadersSchema)(
    normalizeHeaders(headers),
  ).pipe(
    Effect.mapError(() => invalidRequest("Missing or malformed required Codex identity headers.")),
  );
});

/** Decodes the JSON-valued `x-codex-turn-metadata` request header. */
const decodeTurnMetadata = Effect.fnUntraced(function* (encodedMetadata: string) {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(codexTurnMetadataSchema))(
    encodedMetadata,
  ).pipe(Effect.mapError(() => invalidRequest("Malformed turn metadata header.")));
});

/** Extracts optional `client_metadata` from a decoded Responses request body. */
const decodeBodyClientMetadata = Effect.fnUntraced(function* (body: Schema.Json) {
  return yield* Option.match(bodyClientMetadataOption(body), {
    onNone: () => Effect.map(Effect.void, () => undefined),
    onSome: (metadata) =>
      Schema.decodeUnknownEffect(codexBodyClientMetadataSchema)(metadata).pipe(
        Effect.mapError(() => invalidRequest("Malformed body client_metadata.")),
      ),
  });
});

/** Decodes optional Codex reasoning advisory input from the Responses request body. */
const decodeAdvisoryEffort = Effect.fnUntraced(function* (body: Schema.Json) {
  return yield* Option.match(bodyReasoningOption(body), {
    onNone: () => Effect.map(Effect.void, (): CodexAdvisoryEffort | undefined => undefined),
    onSome: (reasoning) =>
      Schema.decodeUnknownEffect(codexBodyReasoningSchema)(reasoning).pipe(
        Effect.map((decodedReasoning) => decodedReasoning.effort),
        Effect.mapError(() => invalidRequest("Unsupported Codex reasoning.effort advisory.")),
      ),
  });
});

/** Fails when two duplicate identity sources disagree. */
const requireMatchingIdentity = Effect.fnUntraced(function* ({
  label,
  expected,
  actual,
}: {
  readonly label: string;
  readonly expected: string;
  readonly actual: string | undefined;
}) {
  const conflict = Option.fromUndefinedOr(
    [actual]
      .filter((value): value is string => value !== undefined)
      .filter((value) => value !== expected)
      .at(0),
  );

  return yield* Option.match(conflict, {
    onNone: () => Effect.void,
    onSome: (received) =>
      Effect.fail(
        invalidRequest(
          `Codex identity conflict for ${label}: expected ${expected}, received ${received}.`,
        ),
      ),
  });
});

/** Cross-checks duplicate Codex identity fields across headers, metadata, and body metadata. */
const validateIdentityConsistency = Effect.fnUntraced(function* ({
  headers,
  metadata,
  bodyMetadata,
}: {
  readonly headers: typeof codexRequestHeadersSchema.Type;
  readonly metadata: typeof codexTurnMetadataSchema.Type;
  readonly bodyMetadata: typeof codexBodyClientMetadataSchema.Type | undefined;
}) {
  yield* requireMatchingIdentity({
    label: "session_id",
    expected: headers["session-id"],
    actual: metadata.session_id,
  });
  yield* requireMatchingIdentity({
    label: "thread_id",
    expected: headers["thread-id"],
    actual: metadata.thread_id,
  });
  yield* requireMatchingIdentity({
    label: "parent_thread_id",
    expected: headers["x-codex-parent-thread-id"],
    actual: metadata.parent_thread_id,
  });
  yield* requireMatchingIdentity({
    label: "window_id",
    expected: headers["x-codex-window-id"],
    actual: metadata.window_id,
  });
  yield* requireMatchingIdentity({
    label: "client_metadata.thread_id",
    expected: headers["thread-id"],
    actual: bodyMetadata?.thread_id,
  });
  yield* requireMatchingIdentity({
    label: "client_metadata.turn_id",
    expected: metadata.turn_id,
    actual: bodyMetadata?.turn_id,
  });
});

/** Parses raw provider query params while rejecting duplicate option names. */
const parseProviderQueryParams = Effect.fnUntraced(function* (url: string) {
  const parsedUrl = new URL(url, "http://caara.local");
  const queryEntries = [...parsedUrl.searchParams.entries()];
  const queryKeys = queryEntries.map(([key]) => key);
  const duplicateKey = queryKeys.find((key, index) => queryKeys.indexOf(key) !== index);

  return yield* Option.match(Option.fromUndefinedOr(duplicateKey), {
    onNone: () => Effect.succeed(Object.fromEntries(queryEntries)),
    onSome: (key) => Effect.fail(invalidRequest(`Duplicate provider query param: ${key}.`)),
  });
});

/** Parses the Responses model string into an open external agent target. */
const parseAgentTarget = Effect.fnUntraced(function* ({
  requestedModel,
  rawDriverOptions,
}: {
  readonly requestedModel: string;
  readonly rawDriverOptions: Readonly<Record<string, string>>;
}) {
  const separatorIndex = requestedModel.indexOf("/");
  const malformedModelMessage = [
    "Responses request model must use <external-agent-kind>/<external-model>.",
  ]
    .filter(() => separatorIndex <= 0 || separatorIndex === requestedModel.length - 1)
    .at(0);

  yield* Option.match(Option.fromUndefinedOr(malformedModelMessage), {
    onNone: () => Effect.void,
    onSome: (message) => Effect.fail(invalidRequest(message)),
  });

  const externalAgentKind = requestedModel.slice(0, separatorIndex);
  const externalModelSpecifier = requestedModel.slice(separatorIndex + 1);
  const invalidExternalAgentKind = [externalAgentKind]
    .filter((kind) => !externalAgentKindPattern.test(kind))
    .at(0);
  yield* Option.match(Option.fromUndefinedOr(invalidExternalAgentKind), {
    onNone: () => Effect.void,
    onSome: (kind) =>
      Effect.fail(
        invalidRequest(`External agent kind must be a lowercase slug, received ${kind}.`),
      ),
  });

  return new AgentTarget({
    requestedModel,
    externalAgentKind,
    externalModelSpecifier,
    rawDriverOptions,
  });
});

/** Normalizes Codex sandbox metadata into the coarse posture shared with drivers. */
const sandboxPostureFromMetadata = ({
  metadata,
}: {
  readonly metadata: typeof codexTurnMetadataSchema.Type;
}): CodexSandboxPosture =>
  Match.value(metadata.sandbox).pipe(
    Match.when("none", (): CodexSandboxPosture => "none"),
    Match.orElse((): CodexSandboxPosture => "enforced"),
  );

/** Returns absolute workspace paths from the validated Codex metadata object. */
const workspacePathsFromMetadata = ({
  metadata,
  pathService,
}: {
  readonly metadata: typeof codexTurnMetadataSchema.Type;
  readonly pathService: Path.Path;
}): readonly string[] =>
  Object.keys(metadata.workspaces ?? {}).filter((workspacePath) =>
    pathService.isAbsolute(workspacePath),
  );

/** Returns body-derived cwd candidates after absolute-path validation and de-duplication. */
const cwdCandidatesFromBody = ({
  body,
  pathService,
}: {
  readonly body: Schema.Json;
  readonly pathService: Path.Path;
}): readonly string[] => [
  ...new Set(extractCwdCandidates(body).filter((candidate) => pathService.isAbsolute(candidate))),
];

/** Enforces that a new external code-agent binding has at least one cwd source. */
const validateCwdRequirement = Effect.fnUntraced(function* ({
  requireCwd,
  workspacePaths,
  cwdCandidates,
}: {
  readonly requireCwd: boolean;
  readonly workspacePaths: readonly string[];
  readonly cwdCandidates: readonly string[];
}) {
  const missingCwdMessage = [
    "A cwd or Codex workspace path is required for a new external code-agent binding.",
  ]
    .filter(() => requireCwd && workspacePaths.length === 0 && cwdCandidates.length === 0)
    .at(0);

  return yield* Option.match(Option.fromUndefinedOr(missingCwdMessage), {
    onNone: () => Effect.void,
    onSome: (message) => Effect.fail(invalidRequest(message)),
  });
});

/** Decodes a Codex-shaped Responses request into validated turn context and target data. */
export const decodeCodexTurnRequest = Effect.fnUntraced(function* ({
  headers,
  url,
  body,
  requireCwd,
}: DecodeCodexTurnRequestOptions) {
  const responses = yield* decodeResponsesCreateRequest(body).pipe(
    Effect.mapError(() =>
      invalidRequest("Responses request must include model, input, and stream: true."),
    ),
  );
  const decodedHeaders = yield* decodeCodexHeaders(headers);
  const metadata = yield* decodeTurnMetadata(decodedHeaders["x-codex-turn-metadata"]);
  const bodyMetadata = yield* decodeBodyClientMetadata(body);
  const advisoryEffort = yield* decodeAdvisoryEffort(body);
  const pathService = yield* Path.Path;
  yield* validateIdentityConsistency({ headers: decodedHeaders, metadata, bodyMetadata });

  const rawDriverOptions = yield* parseProviderQueryParams(url);
  const target = yield* parseAgentTarget({
    requestedModel: responses.model,
    rawDriverOptions,
  });
  const workspacePaths = workspacePathsFromMetadata({ metadata, pathService });
  const sandboxPosture = sandboxPostureFromMetadata({ metadata });
  const cwdCandidates = cwdCandidatesFromBody({ body, pathService });
  yield* validateCwdRequirement({ requireCwd, workspacePaths, cwdCandidates });

  return {
    responses,
    codex: new CodexTurnContext({
      parentSessionId: decodedHeaders["session-id"],
      threadId: decodedHeaders["thread-id"],
      turnId: metadata.turn_id,
      parentThreadId: decodedHeaders["x-codex-parent-thread-id"],
      windowId: decodedHeaders["x-codex-window-id"],
      requestKind: metadata.request_kind,
      subagentKind: metadata.subagent_kind,
      originator: decodedHeaders.originator,
      requestedModel: responses.model,
      advisoryEffort,
      sandboxPosture,
      workspacePaths,
      cwdCandidates,
    }),
    target,
  };
});
