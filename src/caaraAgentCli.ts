import { BunHttpClient } from "@effect/platform-bun";
import { Console, Effect, Match, Option, Runtime, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  agentExitCode,
  caaraAgentContractVersion,
  CaaraAgentErrorKind,
  PortableAgentCancelResult,
  PortableAgentCommandResultSchema,
  type PortableAgentCommandResult,
  PortableAgentErrorResult,
  PortableAgentStartResult,
  PortableAgentWaitResult,
  renderAgentResult,
} from "./caaraAgentContract.ts";
import type { CaaraConfigLoader, CaaraSettingsEnvironment } from "./caaraSettings.ts";
import { resolveCaaraSettingsFromArgs } from "./caaraSettings.ts";
import { caaraHealthProbeUrl } from "./caaraStatus.ts";
import {
  PortableAgentCancelResponse,
  PortableAgentStartServiceResponse,
  PortableAgentWaitResponse,
} from "./portableAgentHttp.ts";
import { PortableTurnId } from "./portableAgentIdentity.ts";

/** Maximum prompt bytes accepted by the public CLI adapter. */
export const caaraAgentMaximumPromptBytes = 1_048_576;

/** Mutually exclusive prompt source selected by the command parser. */
export type CaaraAgentPromptSource =
  | { readonly _tag: "Direct"; readonly value: string }
  | { readonly _tag: "File"; readonly path: string }
  | { readonly _tag: "Stdin" };

/** Reader seam for file and standard-input prompt forms. */
export interface CaaraAgentPromptReader {
  readonly file: (path: string) => EffectContract<string, CaaraAgentCliError>;
  readonly stdin: EffectContract<string, CaaraAgentCliError>;
}

/** Failure returned by the portable Agent CLI boundary. */
export class CaaraAgentCliError extends Schema.TaggedErrorClass<CaaraAgentCliError>()(
  "CaaraAgentCliError",
  { kind: CaaraAgentErrorKind, message: Schema.String },
) {
  /** Runtime process status associated with this public error kind. */
  override get [Runtime.errorExitCode](): number {
    return agentExitCode({
      schemaVersion: caaraAgentContractVersion,
      status: "error",
      error: { kind: this.kind, message: this.message || "Portable Agent command failed." },
    });
  }
}

/** Complete HTTP response required for explicit transport error classification. */
export interface CaaraAgentApiResponse {
  readonly status: number;
  readonly body: Schema.Json;
}

/** HTTP seam used by portable Agent command tests. */
export interface CaaraAgentApi {
  readonly post: (input: {
    readonly url: string;
    readonly body: Schema.Json;
  }) => EffectContract<CaaraAgentApiResponse, CaaraAgentCliError>;
  readonly get: (url: string) => EffectContract<CaaraAgentApiResponse, CaaraAgentCliError>;
}

/** Inputs accepted by the in-process portable Agent start command. */
export interface RunCaaraAgentStartOptions {
  readonly args: readonly string[];
  readonly prompt: string;
  readonly target: string;
  readonly cwd: string;
  readonly driverOptions: Readonly<Record<string, string>>;
  readonly sessionId?: string;
  readonly api?: CaaraAgentApi;
  readonly configLoader?: CaaraConfigLoader;
  readonly env?: CaaraSettingsEnvironment;
}

/** Inputs accepted by the in-process portable Agent wait command. */
export interface RunCaaraAgentWaitOptions {
  readonly args: readonly string[];
  readonly turnId: string;
  readonly timeoutMillis?: number;
  readonly api?: CaaraAgentApi;
  readonly configLoader?: CaaraConfigLoader;
  readonly env?: CaaraSettingsEnvironment;
}

/** Inputs accepted by the in-process portable Agent cancellation command. */
export interface RunCaaraAgentCancelOptions {
  readonly args: readonly string[];
  readonly turnId: string;
  readonly api?: CaaraAgentApi;
  readonly configLoader?: CaaraConfigLoader;
  readonly env?: CaaraSettingsEnvironment;
}

/** Creates one typed CLI error without leaking transport response content. */
const cliError = ({
  kind,
  message,
}: {
  readonly kind: typeof CaaraAgentErrorKind.Type;
  readonly message: string;
}): CaaraAgentCliError => new CaaraAgentCliError({ kind, message });

/** Live prompt reader preserving all bytes decoded as UTF-8 text. */
export const liveCaaraAgentPromptReader: CaaraAgentPromptReader = {
  file: (path) =>
    Effect.tryPromise({
      try: () => Bun.file(path).text(),
      catch: () =>
        cliError({ kind: "invalid_request", message: `Cannot read prompt file: ${path}.` }),
    }),
  stdin: Effect.tryPromise({
    try: () => Bun.stdin.text(),
    catch: () => cliError({ kind: "invalid_request", message: "Cannot read prompt from stdin." }),
  }),
};

/** Reads one selected prompt and validates the public size/non-empty boundary. */
export const resolveCaaraAgentPrompt = Effect.fnUntraced(function* ({
  source,
  reader = liveCaaraAgentPromptReader,
}: {
  readonly source: CaaraAgentPromptSource;
  readonly reader?: CaaraAgentPromptReader;
}) {
  const prompt = yield* Match.valueTags(source, {
    Direct: ({ value }) => Effect.succeed(value),
    File: ({ path }) => reader.file(path),
    Stdin: () => reader.stdin,
  });
  const byteLength = new TextEncoder().encode(prompt).byteLength;
  return yield* Match.value(byteLength > 0 && byteLength <= caaraAgentMaximumPromptBytes).pipe(
    Match.when(true, () => Effect.succeed(prompt)),
    Match.orElse(() =>
      cliError({
        kind: "invalid_request",
        message: `Prompt must contain 1-${caaraAgentMaximumPromptBytes} UTF-8 bytes.`,
      }),
    ),
  );
});

/** Maps unexpected live HTTP failures to unavailable-service semantics. */
const unavailableServiceError = (cause: unknown): CaaraAgentCliError =>
  cliError({
    kind: "service_unavailable",
    message: `Caara service unavailable: ${String(cause)}.`,
  });

/** Reads the JSON body while preserving the service status. */
const readHttpResponse = Effect.fnUntraced(function* (response: {
  readonly status: number;
  readonly json: EffectContract<Schema.Json, unknown>;
}) {
  const body = yield* response.json.pipe(Effect.mapError(unavailableServiceError));
  return { status: response.status, body } satisfies CaaraAgentApiResponse;
});

/** Live HTTP implementation used by installed `caara agent` commands. */
export const liveCaaraAgentApi: CaaraAgentApi = {
  post: ({ url, body }) =>
    HttpClientRequest.bodyJson(HttpClientRequest.post(url), body).pipe(
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(readHttpResponse),
      Effect.mapError(unavailableServiceError),
      Effect.provide(BunHttpClient.layer),
    ),
  get: (url) =>
    HttpClient.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(readHttpResponse),
      Effect.mapError(unavailableServiceError),
      Effect.provide(BunHttpClient.layer),
    ),
};

/** Resolves the loopback service origin from normal Caara settings flags. */
const resolveAgentServiceOrigin = Effect.fnUntraced(function* ({
  args,
  configLoader,
  env,
}: {
  readonly args: readonly string[];
  readonly configLoader: CaaraConfigLoader | undefined;
  readonly env: CaaraSettingsEnvironment | undefined;
}) {
  const settings = yield* resolveCaaraSettingsFromArgs({ args, configLoader, env });
  return caaraHealthProbeUrl({ settings }).replace(/\/health$/u, "");
});

/** Decodes an explicit typed service error for one non-success response. */
const requireSuccessfulResponse = Effect.fnUntraced(function* (response: CaaraAgentApiResponse) {
  if (response.status >= 200 && response.status < 300) return response.body;
  const error = yield* Schema.decodeUnknownEffect(PortableAgentErrorResult)(response.body).pipe(
    Effect.mapError(() => unavailableServiceError(`HTTP ${response.status}`)),
  );
  return yield* cliError(error.error);
});

/** Starts one portable Agent turn through the running user service. */
export const runCaaraAgentStart = Effect.fnUntraced(function* ({
  args,
  prompt,
  target,
  cwd,
  driverOptions,
  sessionId,
  api = liveCaaraAgentApi,
  configLoader,
  env,
}: RunCaaraAgentStartOptions) {
  const origin = yield* resolveAgentServiceOrigin({ args, configLoader, env });
  const response = yield* api.post({
    url: `${origin}/agent/turns`,
    body: {
      prompt,
      target,
      cwd,
      driverOptions,
      ...Option.match(Option.fromUndefinedOr(sessionId), {
        onNone: () => ({}),
        onSome: (selected) => ({ sessionId: selected }),
      }),
    },
  });
  const body = yield* requireSuccessfulResponse(response);
  const accepted = yield* Schema.decodeUnknownEffect(PortableAgentStartServiceResponse)(body).pipe(
    Effect.mapError(unavailableServiceError),
  );
  return yield* Schema.decodeUnknownEffect(PortableAgentStartResult)({
    schemaVersion: caaraAgentContractVersion,
    turnId: accepted.turnId,
    sessionId: accepted.sessionId,
    status: "accepted",
    observationUrl: `${origin}${accepted.observationPath}`,
  }).pipe(Effect.mapError(unavailableServiceError));
});

/** Reads only the coarse or final terminal projection of one portable turn. */
export const runCaaraAgentWait = Effect.fnUntraced(function* ({
  args,
  turnId,
  timeoutMillis,
  api = liveCaaraAgentApi,
  configLoader,
  env,
}: RunCaaraAgentWaitOptions) {
  const validTurnId = yield* Schema.decodeUnknownEffect(PortableTurnId)(turnId).pipe(
    Effect.mapError(() =>
      cliError({ kind: "invalid_request", message: "Malformed portable turn ID." }),
    ),
  );
  const origin = yield* resolveAgentServiceOrigin({ args, configLoader, env });
  const timeoutQuery = Option.match(Option.fromUndefinedOr(timeoutMillis), {
    onNone: () => "",
    onSome: (value) => `?timeoutMillis=${encodeURIComponent(value)}`,
  });
  const response = yield* api.get(
    `${origin}/agent/turns/${encodeURIComponent(validTurnId)}${timeoutQuery}`,
  );
  const body = yield* requireSuccessfulResponse(response);
  const result = yield* Schema.decodeUnknownEffect(PortableAgentWaitResponse)(body).pipe(
    Effect.mapError(unavailableServiceError),
  );
  return yield* Schema.decodeUnknownEffect(PortableAgentWaitResult)({
    schemaVersion: caaraAgentContractVersion,
    ...result,
  }).pipe(Effect.mapError(unavailableServiceError));
});

/** Cancels one working portable turn and returns its terminal policy. */
export const runCaaraAgentCancel = Effect.fnUntraced(function* ({
  args,
  turnId,
  api = liveCaaraAgentApi,
  configLoader,
  env,
}: RunCaaraAgentCancelOptions) {
  const validTurnId = yield* Schema.decodeUnknownEffect(PortableTurnId)(turnId).pipe(
    Effect.mapError(() =>
      cliError({ kind: "invalid_request", message: "Malformed portable turn ID." }),
    ),
  );
  const origin = yield* resolveAgentServiceOrigin({ args, configLoader, env });
  const response = yield* api.post({
    url: `${origin}/agent/turns/${encodeURIComponent(validTurnId)}/cancel`,
    body: {},
  });
  const body = yield* requireSuccessfulResponse(response);
  const result = yield* Schema.decodeUnknownEffect(PortableAgentCancelResponse)(body).pipe(
    Effect.mapError(unavailableServiceError),
  );
  return yield* Schema.decodeUnknownEffect(PortableAgentCancelResult)({
    schemaVersion: caaraAgentContractVersion,
    ...result,
  }).pipe(Effect.mapError(unavailableServiceError));
});

/** Prints a typed command result in the selected public presentation. */
const printAgentResult = Effect.fnUntraced(function* ({
  result,
  json,
}: {
  readonly result: PortableAgentCommandResult;
  readonly json: boolean;
}) {
  const output = yield* Match.value(json).pipe(
    Match.when(true, () =>
      Schema.encodeEffect(Schema.fromJsonString(PortableAgentCommandResultSchema))(result),
    ),
    Match.orElse(() => Effect.succeed(renderAgentResult(result))),
  );
  yield* Console.log(output);
  process.exitCode = agentExitCode(result);
});

/** Prints one typed error result and selects its documented process status. */
const printAgentError = Effect.fnUntraced(function* ({
  error,
  json,
}: {
  readonly error: CaaraAgentCliError;
  readonly json: boolean;
}) {
  const result = {
    schemaVersion: caaraAgentContractVersion,
    status: "error",
    error: { kind: error.kind, message: error.message },
  } as const;
  const output = yield* Match.value(json).pipe(
    Match.when(true, () =>
      Schema.encodeEffect(Schema.fromJsonString(PortableAgentErrorResult))(result),
    ),
    Match.orElse(() => Effect.succeed(renderAgentResult(result))),
  );
  yield* Console.error(output);
  process.exitCode = agentExitCode(result);
});

/** Prints one parser/input failure through the same public result contract. */
export const runCaaraAgentInputErrorCli = ({
  error,
  json,
}: {
  readonly error: CaaraAgentCliError;
  readonly json: boolean;
}) => printAgentError({ error, json });

/** Runs live start and prints one selected stable representation. */
export const runCaaraAgentStartCli = Effect.fnUntraced(function* (
  input: RunCaaraAgentStartOptions & { readonly json: boolean },
) {
  return yield* runCaaraAgentStart(input).pipe(
    Effect.flatMap((result) => printAgentResult({ result, json: input.json })),
    Effect.catchTag("CaaraAgentCliError", (error) => printAgentError({ error, json: input.json })),
  );
});

/** Runs live wait and prints one selected stable representation. */
export const runCaaraAgentWaitCli = Effect.fnUntraced(function* (
  input: RunCaaraAgentWaitOptions & { readonly json: boolean },
) {
  return yield* runCaaraAgentWait(input).pipe(
    Effect.flatMap((result) => printAgentResult({ result, json: input.json })),
    Effect.catchTag("CaaraAgentCliError", (error) => printAgentError({ error, json: input.json })),
  );
});

/** Runs live cancellation and prints one selected stable representation. */
export const runCaaraAgentCancelCli = Effect.fnUntraced(function* (
  input: RunCaaraAgentCancelOptions & { readonly json: boolean },
) {
  return yield* runCaaraAgentCancel(input).pipe(
    Effect.flatMap((result) => printAgentResult({ result, json: input.json })),
    Effect.catchTag("CaaraAgentCliError", (error) => printAgentError({ error, json: input.json })),
  );
});
