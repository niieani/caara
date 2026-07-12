import { BunHttpClient } from "@effect/platform-bun";
import { Console, Effect, Match, Option, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";

import type { CaaraConfigLoader, CaaraSettingsEnvironment } from "./caaraSettings.ts";
import { resolveCaaraSettingsFromArgs } from "./caaraSettings.ts";
import { caaraHealthProbeUrl } from "./caaraStatus.ts";
import {
  PortableAgentStartResponse,
  PortableAgentStartServiceResponse,
  PortableAgentWaitResponse,
} from "./portableAgentHttp.ts";

/** Failure returned by the portable Agent CLI transport boundary. */
export class CaaraAgentCliError extends Schema.TaggedErrorClass<CaaraAgentCliError>()(
  "CaaraAgentCliError",
  { message: Schema.String },
) {}

/** HTTP seam used by portable Agent command tests. */
export interface CaaraAgentApi {
  readonly post: (input: {
    readonly url: string;
    readonly body: Schema.Json;
  }) => EffectContract<Schema.Json, CaaraAgentCliError>;
  readonly get: (url: string) => EffectContract<Schema.Json, CaaraAgentCliError>;
}

/** Inputs accepted by the in-process portable Agent start command. */
export interface RunCaaraAgentStartOptions {
  readonly args: readonly string[];
  readonly prompt: string;
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

/** Maps one unknown HTTP failure into the command's explicit error flow. */
const agentCliError = (cause: unknown): CaaraAgentCliError =>
  new CaaraAgentCliError({ message: String(cause) });

/** Decodes JSON only from successful service responses. */
const decodeSuccessfulJson = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const json = Match.value(response.status >= 200 && response.status < 300).pipe(
    Match.when(true, () => response.json),
    Match.orElse(() =>
      Effect.fail(
        new CaaraAgentCliError({
          message: `Caara Agent endpoint returned HTTP ${response.status}.`,
        }),
      ),
    ),
  );
  return yield* json.pipe(Effect.mapError(agentCliError));
});

/** Live HTTP implementation used by installed `caara agent` commands. */
export const liveCaaraAgentApi: CaaraAgentApi = {
  post: ({ url, body }) =>
    HttpClientRequest.bodyJson(HttpClientRequest.post(url), body).pipe(
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(decodeSuccessfulJson),
      Effect.mapError(agentCliError),
      Effect.provide(BunHttpClient.layer),
    ),
  get: (url) =>
    HttpClient.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(decodeSuccessfulJson),
      Effect.mapError(agentCliError),
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

/** Starts a portable diagnostic turn through the running user service. */
export const runCaaraAgentStart = Effect.fnUntraced(function* ({
  args,
  prompt,
  sessionId,
  api = liveCaaraAgentApi,
  configLoader,
  env,
}: RunCaaraAgentStartOptions) {
  const origin = yield* resolveAgentServiceOrigin({ args, configLoader, env });
  const body = yield* api.post({
    url: `${origin}/agent/turns`,
    body: {
      prompt,
      ...Option.match(Option.fromUndefinedOr(sessionId), {
        onNone: () => ({}),
        onSome: (selected) => ({ sessionId: selected }),
      }),
    },
  });
  const accepted = yield* Schema.decodeUnknownEffect(PortableAgentStartServiceResponse)(body).pipe(
    Effect.mapError(agentCliError),
  );
  return yield* Schema.decodeUnknownEffect(PortableAgentStartResponse)({
    turnId: accepted.turnId,
    sessionId: accepted.sessionId,
    status: accepted.status,
    observationUrl: `${origin}${accepted.observationPath}`,
  }).pipe(Effect.mapError(agentCliError));
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
  const origin = yield* resolveAgentServiceOrigin({ args, configLoader, env });
  const timeoutQuery = Option.match(Option.fromUndefinedOr(timeoutMillis), {
    onNone: () => "",
    onSome: (value) => `?timeoutMillis=${encodeURIComponent(value)}`,
  });
  const body = yield* api.get(`${origin}/agent/turns/${encodeURIComponent(turnId)}${timeoutQuery}`);
  return yield* Schema.decodeUnknownEffect(PortableAgentWaitResponse)(body).pipe(
    Effect.mapError(agentCliError),
  );
});

/** Runs live start and prints exactly one machine-readable JSON result. */
export const runCaaraAgentStartCli = Effect.fnUntraced(function* ({
  args,
  prompt,
  sessionId,
}: {
  readonly args: readonly string[];
  readonly prompt: string;
  readonly sessionId?: string;
}) {
  const result = yield* runCaaraAgentStart({ args, prompt, sessionId });
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PortableAgentStartResponse))(
    result,
  );
  return yield* Console.log(encoded);
});

/** Runs live wait and prints exactly one agent-safe JSON result. */
export const runCaaraAgentWaitCli = Effect.fnUntraced(function* ({
  args,
  turnId,
  timeoutMillis,
}: {
  readonly args: readonly string[];
  readonly turnId: string;
  readonly timeoutMillis?: number;
}) {
  const result = yield* runCaaraAgentWait({ args, turnId, timeoutMillis });
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PortableAgentWaitResponse))(
    result,
  );
  return yield* Console.log(encoded);
});
