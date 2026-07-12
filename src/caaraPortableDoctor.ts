import { BunHttpClient } from "@effect/platform-bun";
import { Effect, Match, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  PortableAgentStartServiceResponse,
  PortableAgentWaitResponse,
} from "./portableAgentHttp.ts";

/** Successful proof returned after exercising portable execution and its human viewer. */
export interface CaaraPortableDoctorProof {
  readonly observationUrl: string;
}

/** Portable-capability probe seam used by doctor and lifecycle tests. */
export interface CaaraPortableDoctorProbe {
  readonly probe: (input: {
    readonly cwd: string;
    readonly origin: string;
  }) => EffectContract<CaaraPortableDoctorProof, unknown>;
}

/** Result of the installed-service portable capability check. */
export interface CaaraPortableDoctorResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
}

/** Typed failure raised when an installed portable capability violates its HTTP contract. */
export class CaaraPortableDoctorProbeError extends Schema.TaggedErrorClass<CaaraPortableDoctorProbeError>()(
  "CaaraPortableDoctorProbeError",
  { message: Schema.String },
) {}

/** Builds one typed installed portable-capability contract failure. */
const portableProbeError = (message: string): CaaraPortableDoctorProbeError =>
  new CaaraPortableDoctorProbeError({ message });

/** Converts an unknown probe failure into stable repair-oriented doctor output. */
export const portableDoctorFailureMessage = ({ cause }: { readonly cause: unknown }): string =>
  [
    `portable delegation unavailable: ${String(cause)}`,
    "repair: run caara install-service to install and start the compiled user service.",
    "repair: install at least one external-agent executable, then run caara doctor --fix so its directory is in the service execution path.",
  ].join("\n");

/** Runs one portable capability check and normalizes it for doctor presentation. */
export const runPortableDoctorCheck = Effect.fnUntraced(function* ({
  cwd,
  origin,
  probe,
}: {
  readonly cwd: string;
  readonly origin: string;
  readonly probe: CaaraPortableDoctorProbe;
}) {
  return yield* probe.probe({ cwd, origin }).pipe(
    Effect.map(
      () =>
        ({
          exitCode: 0,
          message:
            "ok portable diagnostic turn completed; loopback observation viewer served human activity",
        }) satisfies CaaraPortableDoctorResult,
    ),
    Effect.catch((cause) =>
      Effect.succeed({
        exitCode: 1,
        message: portableDoctorFailureMessage({ cause }),
      } satisfies CaaraPortableDoctorResult),
    ),
  );
});

/** Reads one response as JSON and validates it with an Effect schema. */
const decodeResponse = Effect.fnUntraced(function* <A, I, R>({
  response,
  schema,
}: {
  readonly response: { readonly json: EffectContract<unknown, unknown> };
  readonly schema: Schema.Codec<A, I, R>;
}) {
  const body = yield* response.json;
  return yield* Schema.decodeUnknownEffect(schema)(body);
});

/** Requires an HTTP success response before decoding its body. */
const requireSuccess = Effect.fnUntraced(function* <A extends { readonly status: number }>({
  response,
  operation,
}: {
  readonly response: A;
  readonly operation: string;
}) {
  return yield* Match.value(response.status >= 200 && response.status < 300).pipe(
    Match.when(true, () => Effect.succeed(response)),
    Match.orElse(() =>
      Effect.fail(portableProbeError(`${operation} returned HTTP ${response.status}`)),
    ),
  );
});

/** Live portable capability probe using only installed service HTTP contracts. */
export const liveCaaraPortableDoctorProbe: CaaraPortableDoctorProbe = {
  probe: Effect.fnUntraced(function* ({ cwd, origin }) {
    const startBody = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
      prompt: "Caara doctor portable capability check",
      target: "diagnostic/activity",
      cwd,
      driverOptions: {},
    });
    const startRequest = HttpClientRequest.bodyText(
      HttpClientRequest.post(`${origin}/agent/turns`),
      startBody,
      "application/json",
    );
    const startResponse = yield* HttpClient.execute(startRequest).pipe(
      Effect.flatMap((response) => requireSuccess({ response, operation: "portable start" })),
      Effect.provide(BunHttpClient.layer),
    );
    const started = yield* decodeResponse({
      response: startResponse,
      schema: PortableAgentStartServiceResponse,
    });
    const observationUrl = new URL(started.observationPath, origin).toString();
    const cleanupAcceptedTurn = HttpClient.execute(
      HttpClientRequest.post(`${origin}/agent/turns/${started.turnId}/cancel`),
    ).pipe(Effect.ignore, Effect.provide(BunHttpClient.layer));
    const inspectAcceptedTurn = Effect.gen(function* () {
      const viewerResponse = yield* HttpClient.execute(HttpClientRequest.get(observationUrl)).pipe(
        Effect.flatMap((response) => requireSuccess({ response, operation: "observation viewer" })),
        Effect.provide(BunHttpClient.layer),
      );
      const viewerHtml = yield* viewerResponse.text;
      yield* Effect.succeed(viewerHtml).pipe(
        Effect.filterOrFail(
          (html) => html.includes("<h1>Agent turn</h1>"),
          () => portableProbeError("observation viewer returned invalid HTML"),
        ),
      );
      const waitResponse = yield* HttpClient.execute(
        HttpClientRequest.get(`${origin}/agent/turns/${started.turnId}?timeoutMillis=3000`),
      ).pipe(
        Effect.flatMap((response) => requireSuccess({ response, operation: "portable wait" })),
        Effect.provide(BunHttpClient.layer),
      );
      const terminal = yield* decodeResponse({
        response: waitResponse,
        schema: PortableAgentWaitResponse,
      });
      yield* Effect.succeed(terminal).pipe(
        Effect.filterOrFail(
          (result) => result.status === "completed",
          (result) => portableProbeError(`portable turn ended with ${result.status}`),
        ),
      );
      return { observationUrl } satisfies CaaraPortableDoctorProof;
    });
    return yield* inspectAcceptedTurn.pipe(Effect.ensuring(cleanupAcceptedTurn));
  }),
};
