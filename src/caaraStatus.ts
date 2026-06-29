import { BunHttpClient } from "@effect/platform-bun";
import { Console, Effect, Match, Option, Result, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  type CaaraConfigLoader,
  type CaaraSettingsEnvironment,
  type CaaraSettingsValue,
  resolveCaaraSettingsFromArgs,
} from "./caaraSettings.ts";

/** Payload returned by Caara's shallow health endpoint. */
export const CaaraHealthPayload = Schema.Struct({
  status: Schema.Literal("ok"),
  service: Schema.Literal("caara"),
});

/** Runtime type for a successful Caara health payload. */
export type CaaraHealthPayload = typeof CaaraHealthPayload.Type;

/** Failure while probing the Caara health endpoint. */
export class CaaraStatusError extends Schema.TaggedErrorClass<CaaraStatusError>()(
  "CaaraStatusError",
  {
    message: Schema.String,
  },
) {}

/** Health probe seam used by status tests and the live CLI command. */
export interface CaaraHealthProbe {
  readonly probe: (url: string) => EffectContract<CaaraHealthPayload, CaaraStatusError>;
}

/** Result returned by the status command without terminating the process. */
export interface CaaraStatusResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
  readonly url: string | undefined;
}

/** Options accepted by the in-process status command seam. */
export interface RunCaaraStatusOptions {
  readonly args: readonly string[];
  readonly configLoader?: CaaraConfigLoader;
  readonly env?: CaaraSettingsEnvironment;
  readonly probe?: CaaraHealthProbe;
}

/** Options accepted by the live status CLI wrapper. */
export interface RunCaaraStatusCliOptions {
  readonly args: readonly string[];
}

/** Converts an unknown health probe failure into a user-facing message. */
const statusErrorMessage = (cause: unknown): string =>
  Match.value(cause).pipe(
    Match.when(
      (candidate: unknown): candidate is { readonly message: string } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "message" in candidate &&
        typeof candidate.message === "string",
      (error) => error.message,
    ),
    Match.orElse(String),
  );

/** Builds one typed status failure. */
const caaraStatusError = (message: string): CaaraStatusError => new CaaraStatusError({ message });

/** Maps bind-all server hosts to concrete loopback probe hosts. */
export const caaraHealthProbeHost = ({ host }: { readonly host: string }): string =>
  Match.value(host).pipe(
    Match.when("0.0.0.0", () => "127.0.0.1"),
    Match.when("::", () => "::1"),
    Match.orElse((probeHost) => probeHost),
  );

/** Formats a host for use in an HTTP URL, including IPv6 bracket handling. */
const hostForUrl = (host: string): string =>
  [host]
    .filter((probeHost) => probeHost.includes(":"))
    .map((probeHost) => `[${probeHost}]`)
    .at(0) ?? host;

/** Builds the shallow Caara health probe URL for resolved settings. */
export const caaraHealthProbeUrl = ({
  settings,
}: {
  readonly settings: CaaraSettingsValue;
}): string => {
  const host = caaraHealthProbeHost({ host: settings.host });
  return `http://${hostForUrl(host)}:${settings.port}/health`;
};

/** Decodes the JSON response body from a successful health HTTP response. */
const decodeHealthPayload = Effect.fnUntraced(function* (body: Schema.Json) {
  return yield* Schema.decodeUnknownEffect(CaaraHealthPayload)(body).pipe(
    Effect.mapError((cause) =>
      caaraStatusError(`Invalid Caara health response: ${String(cause)}.`),
    ),
  );
});

/** Live HTTP-backed health probe used by `caara status`. */
export const liveCaaraHealthProbe: CaaraHealthProbe = {
  probe: (url) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(HttpClientRequest.get(url));
      const successfulResponse = Option.fromUndefinedOr(
        [response].filter(({ status }) => status === 200).at(0),
      );
      const body = yield* Option.match(successfulResponse, {
        onNone: () =>
          Effect.fail(caaraStatusError(`Health endpoint returned HTTP ${response.status}.`)),
        onSome: (okResponse) => okResponse.json,
      });
      return yield* decodeHealthPayload(body);
    }).pipe(
      Effect.mapError((error) => caaraStatusError(statusErrorMessage(error))),
      Effect.provide(BunHttpClient.layer),
    ),
};

/** Builds the successful status result for one probed URL. */
const healthyStatusResult = ({ url }: { readonly url: string }): CaaraStatusResult => ({
  exitCode: 0,
  message: `Caara healthy at ${url}`,
  url,
});

/** Builds the failing status result for one probed URL. */
const unhealthyStatusResult = ({
  url,
  message,
}: {
  readonly url: string;
  readonly message: string;
}): CaaraStatusResult => ({
  exitCode: 1,
  message: `Caara unhealthy at ${url}: ${message}`,
  url,
});

/** Builds the failing status result for settings/CLI resolution errors. */
const unresolvedStatusResult = ({ message }: { readonly message: string }): CaaraStatusResult => ({
  exitCode: 1,
  message: `Caara status failed: ${message}`,
  url: undefined,
});

/** Probes Caara health using resolved status command settings. */
const probeResolvedStatus = ({
  probe,
  settings,
}: {
  readonly probe: CaaraHealthProbe;
  readonly settings: CaaraSettingsValue;
}) => {
  const url = caaraHealthProbeUrl({ settings });
  return probe.probe(url).pipe(
    Effect.map(() => healthyStatusResult({ url })),
    Effect.catch((error: CaaraStatusError) =>
      Effect.succeed(unhealthyStatusResult({ url, message: error.message })),
    ),
  );
};

/** Runs `caara status` without terminating the host process. */
export const runCaaraStatus = Effect.fnUntraced(function* ({
  args,
  configLoader,
  env,
  probe = liveCaaraHealthProbe,
}: RunCaaraStatusOptions) {
  const settingsResult = yield* Effect.result(
    resolveCaaraSettingsFromArgs({
      args,
      configLoader,
      env,
    }),
  );

  return yield* Result.match(settingsResult, {
    onFailure: (error) => Effect.succeed(unresolvedStatusResult({ message: error.message })),
    onSuccess: (settings) => probeResolvedStatus({ probe, settings }),
  });
});

/** Runs the live `caara status` CLI command and fails for nonzero status. */
export const runCaaraStatusCli = Effect.fnUntraced(function* ({ args }: RunCaaraStatusCliOptions) {
  const result = yield* runCaaraStatus({ args });
  yield* Console.log(result.message);

  return yield* Option.match(
    Option.fromUndefinedOr([result].filter(({ exitCode }) => exitCode !== 0).at(0)),
    {
      onNone: () => Effect.void,
      onSome: (failure) => Effect.fail(caaraStatusError(failure.message)),
    },
  );
});
