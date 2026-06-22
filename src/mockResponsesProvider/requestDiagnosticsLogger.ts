import { Console, Context, Effect, Layer, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";

/** Header names whose values must not be written to diagnostic logs. */
const sensitiveHeaderNames = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-openai-api-key",
]);

/** JSON object keys that commonly carry a process working directory. */
const cwdCandidateKeys = new Set([
  "cwd",
  "current_working_directory",
  "currentworkingdirectory",
  "project_root",
  "projectroot",
  "pwd",
  "workspace",
  "workspace_root",
  "workspaceroot",
  "working_directory",
  "workingdirectory",
  "workdir",
]);

/** Diagnostic snapshot of a raw Codex Responses request received by Caara. */
export interface ResponsesRequestDiagnostics {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Schema.Json;
  readonly cwdCandidates: readonly string[];
}

/** Effect shape returned by request diagnostics logger implementations. */
export type RequestDiagnosticsLoggerEffect = ReturnType<typeof Console.log>;

/** Logs raw request diagnostics at the Codex-facing Responses boundary. */
export class RequestDiagnosticsLogger extends Context.Service<
  RequestDiagnosticsLogger,
  {
    readonly logRequest: (
      diagnostics: ResponsesRequestDiagnostics,
    ) => RequestDiagnosticsLoggerEffect;
  }
>()("@caara/RequestDiagnosticsLogger") {}

/** Encodes request diagnostics as one stable JSON stdout log line. */
export const encodeDiagnosticsLogLine = (diagnostics: ResponsesRequestDiagnostics): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)({
    event: "caara.responses.request",
    ...diagnostics,
  } satisfies Schema.Json);

/** Live diagnostics logger that writes request diagnostics to stdout. */
export const requestDiagnosticsLoggerLive = Layer.succeed(RequestDiagnosticsLogger, {
  logRequest: Effect.fnUntraced(function* (diagnostics: ResponsesRequestDiagnostics) {
    yield* Console.log(encodeDiagnosticsLogLine(diagnostics));
  }),
});

/** Returns true when a JSON value is an object record rather than an array. */
const isJsonRecord = (value: Schema.Json): value is Readonly<Record<string, Schema.Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Normalizes a request-body key for cwd-candidate matching. */
const normalizeCandidateKey = (key: string): string => key.replaceAll("-", "_").toLowerCase();

/** Returns true when a string looks like an absolute local filesystem path. */
const looksLikeAbsolutePath = (value: string): boolean => value.startsWith("/");

/** Returns true when an optional regex capture produced a usable string. */
const isDefinedString = (value: string | undefined): value is string => value !== undefined;

/** Adds one cwd candidate to a mutable accumulator if it is usable and new. */
const addCwdCandidate = (candidates: Set<string>, value: string): void => {
  const candidate = value.trim();
  const candidateEntries = [candidate].filter(
    (entry) => entry.length > 0 && looksLikeAbsolutePath(entry),
  );
  for (const entry of candidateEntries) {
    candidates.add(entry);
  }
};

/** Scans free-form text for XML-style cwd values Codex may embed in prompt context. */
const collectTextCwdCandidates = (candidates: Set<string>, value: string): void => {
  const capturedCandidates = [...value.matchAll(/<cwd>([^<]+)<\/cwd>/g)]
    .map((match) => match[1])
    .filter(isDefinedString);
  for (const candidate of capturedCandidates) {
    addCwdCandidate(candidates, candidate);
  }
};

/** Returns a singleton string array when the JSON value is text. */
const textValuesFromJson = (value: Schema.Json): readonly string[] =>
  [value].filter((entry): entry is string => typeof entry === "string");

/** Returns JSON array children when the JSON value is an array. */
const arrayEntriesFromJson = (value: Schema.Json): readonly Schema.Json[] =>
  [value].filter(Array.isArray).flat();

/** Returns object entries when the JSON value is an object record. */
const recordEntriesFromJson = (value: Schema.Json): ReadonlyArray<readonly [string, Schema.Json]> =>
  [value].filter(isJsonRecord).flatMap(Object.entries);

/** Returns a cwd-like field value when a JSON object entry carries one. */
const cwdCandidateValuesFromEntry = ({
  key,
  value,
}: {
  readonly key: string;
  readonly value: Schema.Json;
}): readonly string[] =>
  [value]
    .filter((entry): entry is string => typeof entry === "string")
    .filter(() => cwdCandidateKeys.has(normalizeCandidateKey(key)));

/** Recursively scans JSON for cwd-like fields and embedded cwd context. */
const collectJsonCwdCandidates = (candidates: Set<string>, value: Schema.Json): void => {
  for (const text of textValuesFromJson(value)) {
    collectTextCwdCandidates(candidates, text);
  }
  for (const entry of arrayEntriesFromJson(value)) {
    collectJsonCwdCandidates(candidates, entry);
  }
  for (const [key, entry] of recordEntriesFromJson(value)) {
    for (const candidate of cwdCandidateValuesFromEntry({ key, value: entry })) {
      addCwdCandidate(candidates, candidate);
    }
    collectJsonCwdCandidates(candidates, entry);
  }
};

/** Extracts stable candidate working directories from a raw Responses request body. */
export const extractCwdCandidates = (body: Schema.Json): readonly string[] => {
  const candidates = new Set<string>();
  collectJsonCwdCandidates(candidates, body);
  return [...candidates];
};

/** Redacts sensitive HTTP header values while preserving names and non-secret values. */
export const redactDiagnosticHeaders = (
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
  const redactedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const redactedValueBySensitivity = new Map<boolean, string>([
      [true, "[redacted]"],
      [false, value],
    ]);
    redactedHeaders[name] =
      redactedValueBySensitivity.get(sensitiveHeaderNames.has(name.toLowerCase())) ?? value;
  }
  return redactedHeaders;
};

/** Builds the request diagnostic payload logged before Responses request validation. */
export const createResponsesRequestDiagnostics = ({
  request,
  body,
}: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly body: Schema.Json;
}): ResponsesRequestDiagnostics => ({
  method: request.method,
  url: request.url,
  headers: redactDiagnosticHeaders(request.headers),
  body,
  cwdCandidates: extractCwdCandidates(body),
});
