import { Context, Effect, Match, Option, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

import { type AgentDriverError, createInvalidPromptAgentDriverError } from "./agentDriver.ts";

/**
 * External agent kinds whose drivers spawn a real external harness. Only these kinds take part in
 * delegation context: they can be an immediate caller, and spawning one adds a delegation level.
 */
export const caaraHarnesses = ["claude", "agy", "codex"] as const;

/** Schema accepting exactly one Caara harness identifier. */
export const CaaraHarness = Schema.Literals(caaraHarnesses);

/** One external harness Caara can spawn and later recognize as an immediate caller. */
export type CaaraHarness = typeof CaaraHarness.Type;

/**
 * Delegation context Caara derives for one Agent turn at its transport boundary.
 *
 * `caller` is the harness that immediately asked Caara for this turn, or `undefined` for a direct
 * human, script, or raw HTTP invocation. `depth` counts the Caara-spawned harnesses above the
 * caller: direct invocation is depth 0, and each harness Caara spawns runs at its caller's depth
 * plus one. The context is never persisted; every turn, including a resumed one, derives it anew.
 */
export interface AgentTurnDelegation {
  readonly caller: CaaraHarness | undefined;
  readonly depth: number;
}

/** Default bound on nested Caara harness entries used when service configuration omits one. */
export const defaultDelegationMaximumDepth = 3;

/**
 * Service-configured maximum number of nested Caara harness entries. A turn whose incoming depth
 * already equals this value is rejected before its harness starts.
 */
export const DelegationMaximumDepth = Context.Reference<number>("@caara/DelegationMaximumDepth", {
  defaultValue: () => defaultDelegationMaximumDepth,
});

/** Environment variable carrying Caara's injected immediate-harness marker. */
export const caaraHarnessEnvironmentVariable = (): string => "CAARA_HARNESS";

/** Environment variable carrying Caara's injected delegation depth marker. */
export const caaraDelegationDepthEnvironmentVariable = (): string => "CAARA_DELEGATION_DEPTH";

/** HTTP header carrying Caara's harness marker to the portable and Responses transports. */
export const caaraHarnessHeader = (): string => "x-caara-harness";

/** HTTP header carrying Caara's delegation depth marker to the portable and Responses transports. */
export const caaraDelegationDepthHeader = (): string => "x-caara-delegation-depth";

/**
 * Native Claude Code marker. Claude Code sets `CLAUDECODE=1` in Bash tool shells and in the
 * environment of the stdio MCP servers it launches.
 */
const claudeCodeNativeEnvironmentVariable = (): string => "CLAUDECODE";

/**
 * Native Codex marker. Codex injects `CODEX_THREAD_ID` into the environment of the shell commands
 * it runs (`codex-rs/core/src/exec_env.rs`).
 */
const codexNativeEnvironmentVariable = (): string => "CODEX_THREAD_ID";

/** Failure raised when delegation markers are malformed or contradict each other. */
export class DelegationMarkerError extends Schema.TaggedErrorClass<DelegationMarkerError>()(
  "DelegationMarkerError",
  { message: Schema.String },
) {}

/** Delegation context of a direct invocation with no harness caller. */
export const directAgentTurnDelegation = (): AgentTurnDelegation => ({
  caller: undefined,
  depth: 0,
});

/** Raw Caara marker values observed at one boundary, before validation. */
interface RawCaaraDelegationMarker {
  readonly harness: string | undefined;
  readonly depth: string | undefined;
  readonly harnessName: string;
  readonly depthName: string;
}

/** Validates one raw harness marker value. */
const parseHarnessMarker = ({
  value,
  name,
}: {
  readonly value: string;
  readonly name: string;
}): EffectContract<CaaraHarness, DelegationMarkerError> =>
  Schema.decodeUnknownEffect(CaaraHarness)(value).pipe(
    Effect.mapError(
      () =>
        new DelegationMarkerError({
          message: `Malformed ${name} delegation marker "${value}": expected one of ${caaraHarnesses.join(", ")}.`,
        }),
    ),
  );

/** Validates one raw depth marker value as a canonical non-negative safe integer. */
const parseDepthMarker = ({
  value,
  name,
}: {
  readonly value: string | undefined;
  readonly name: string;
}): EffectContract<number, DelegationMarkerError> =>
  Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.succeed(0),
    onSome: (raw) =>
      Effect.succeed(Number(raw)).pipe(
        Effect.filterOrFail(
          (depth) => /^(?:0|[1-9][0-9]*)$/u.test(raw) && Number.isSafeInteger(depth),
          () =>
            new DelegationMarkerError({
              message: `Malformed ${name} delegation marker "${raw}": expected a non-negative integer.`,
            }),
        ),
      ),
  });

/**
 * Parses Caara's own marker. A harness without a depth is depth 0 (a host that sets only its
 * harness, such as installed Antigravity guidance); a depth without a harness is malformed.
 */
const parseCaaraDelegationMarker = ({
  harness,
  depth,
  harnessName,
  depthName,
}: RawCaaraDelegationMarker): EffectContract<
  Option.Option<AgentTurnDelegation>,
  DelegationMarkerError
> =>
  Option.match(Option.fromUndefinedOr(harness), {
    onNone: () =>
      Match.value(depth).pipe(
        Match.when(undefined, () => Effect.succeedNone),
        Match.orElse(() =>
          Effect.fail(
            new DelegationMarkerError({
              message: `Malformed delegation marker: ${depthName} is set without ${harnessName}.`,
            }),
          ),
        ),
      ),
    onSome: (rawHarness) =>
      Effect.all({
        caller: parseHarnessMarker({ value: rawHarness, name: harnessName }),
        depth: parseDepthMarker({ value: depth, name: depthName }),
      }).pipe(Effect.map(Option.some)),
  });

/** Validates one native environment marker, returning its harness when present. */
const nativeEnvironmentHarness = ({
  env,
  name,
  harness,
  isValid,
}: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  readonly harness: CaaraHarness;
  readonly isValid: (value: string) => boolean;
}): EffectContract<Option.Option<CaaraHarness>, DelegationMarkerError> =>
  Option.match(Option.fromUndefinedOr(env[name]), {
    onNone: () => Effect.succeedNone,
    onSome: (value) =>
      Match.value(isValid(value)).pipe(
        Match.when(true, () => Effect.succeedSome(harness)),
        Match.orElse(() =>
          Effect.fail(
            new DelegationMarkerError({
              message: `Malformed native ${name} harness marker "${value}".`,
            }),
          ),
        ),
      ),
  });

/** Selects the single native host harness, failing when several native hosts claim the call. */
const singleNativeHarness = (
  harnesses: readonly Option.Option<CaaraHarness>[],
): EffectContract<AgentTurnDelegation, DelegationMarkerError> => {
  const present = harnesses.filter(Option.isSome).map((harness) => harness.value);
  return Match.value(present.length).pipe(
    Match.when(0, () => Effect.succeed(directAgentTurnDelegation())),
    Match.when(1, () => Effect.succeed({ caller: present[0], depth: 0 })),
    Match.orElse(() =>
      Effect.fail(
        new DelegationMarkerError({
          message: `Conflicting native harness markers (${present.join(", ")}); set ${caaraHarnessEnvironmentVariable()} to the calling harness.`,
        }),
      ),
    ),
  );
};

/**
 * Derives the immediate caller of a CLI or MCP invocation from the calling process environment.
 * Caara's injected marker wins; otherwise one verified native host marker identifies the caller;
 * with no marker the invocation is direct.
 */
export const resolveDelegationFromEnvironment = Effect.fnUntraced(function* ({
  env,
}: {
  readonly env: Readonly<Record<string, string | undefined>>;
}) {
  const caaraMarker = yield* parseCaaraDelegationMarker({
    harness: env[caaraHarnessEnvironmentVariable()],
    depth: env[caaraDelegationDepthEnvironmentVariable()],
    harnessName: caaraHarnessEnvironmentVariable(),
    depthName: caaraDelegationDepthEnvironmentVariable(),
  });
  return yield* Option.match(caaraMarker, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.all([
        nativeEnvironmentHarness({
          env,
          name: claudeCodeNativeEnvironmentVariable(),
          harness: "claude",
          isValid: (value) => value === "1",
        }),
        nativeEnvironmentHarness({
          env,
          name: codexNativeEnvironmentVariable(),
          harness: "codex",
          isValid: (value) => value.length > 0,
        }),
      ]).pipe(Effect.flatMap(singleNativeHarness)),
  });
});

/** Reads Caara's marker from lowercase HTTP headers. */
const caaraHeaderMarker = (
  headers: Readonly<Record<string, string | undefined>>,
): RawCaaraDelegationMarker => ({
  harness: headers[caaraHarnessHeader()],
  depth: headers[caaraDelegationDepthHeader()],
  harnessName: caaraHarnessHeader(),
  depthName: caaraDelegationDepthHeader(),
});

/**
 * Derives the delegation context of a portable HTTP start. Only Caara's own marker headers, as
 * forwarded by Caara's CLI and MCP adapters, identify a caller; a raw call is direct.
 */
export const resolveDelegationFromPortableHeaders = ({
  headers,
}: {
  readonly headers: Readonly<Record<string, string | undefined>>;
}): EffectContract<AgentTurnDelegation, DelegationMarkerError> =>
  parseCaaraDelegationMarker(caaraHeaderMarker(headers)).pipe(
    Effect.map(Option.getOrElse(directAgentTurnDelegation)),
  );

/**
 * Derives the delegation context of a Codex-shaped Responses turn. The validated Codex subagent
 * identity headers verify Codex as the immediate caller; Caara's marker headers, forwarded by the
 * installed role's `env_http_headers`, contribute the depth and must agree that the caller is Codex.
 */
export const resolveDelegationFromCodexResponsesHeaders = Effect.fnUntraced(function* ({
  headers,
}: {
  readonly headers: Readonly<Record<string, string | undefined>>;
}) {
  const caaraMarker = yield* parseCaaraDelegationMarker(caaraHeaderMarker(headers));
  return yield* Option.match(caaraMarker, {
    onNone: () => Effect.succeed<AgentTurnDelegation>({ caller: "codex", depth: 0 }),
    onSome: (marker) =>
      Match.value(marker.caller).pipe(
        Match.when("codex", () => Effect.succeed(marker)),
        Match.orElse((caller) =>
          Effect.fail(
            new DelegationMarkerError({
              message: `Conflicting delegation markers: Codex sent this Responses request but ${caaraHarnessHeader()} names ${caller}.`,
            }),
          ),
        ),
      ),
  });
});

/** Narrows an external agent kind to a harness that participates in delegation context. */
export const caaraHarnessFromExternalAgentKind = (
  externalAgentKind: string,
): CaaraHarness | undefined => caaraHarnesses.find((harness) => harness === externalAgentKind);

/** Human-readable harness name used in delegation failures. */
const harnessDisplayName = (harness: CaaraHarness): string =>
  Match.value(harness).pipe(
    Match.when("claude", () => "Claude Code"),
    Match.when("agy", () => "Antigravity"),
    Match.when("codex", () => "Codex"),
    Match.exhaustive,
  );

/** Names the native subagent facility an agent should use instead of same-harness Caara delegation. */
const nativeSubagentAlternative = (harness: CaaraHarness): string =>
  Match.value(harness).pipe(
    Match.when("claude", () => "Use Claude Code's native subagents (the Agent tool) instead."),
    Match.when("agy", () => "Use Antigravity's native subagents instead."),
    Match.when("codex", () => "Use Codex's native subagents (spawn_agent) instead."),
    Match.exhaustive,
  );

/** Selects the policy rejection message for one harness target, if the turn must not start. */
const delegationRejection = ({
  delegation,
  target,
  maximumDepth,
}: {
  readonly delegation: AgentTurnDelegation;
  readonly target: CaaraHarness;
  readonly maximumDepth: number;
}): Option.Option<string> =>
  Match.value(delegation).pipe(
    Match.when({ caller: target }, () =>
      Option.some(
        `Caara rejected same-harness delegation from ${harnessDisplayName(target)} to ${harnessDisplayName(target)}. ${nativeSubagentAlternative(target)}`,
      ),
    ),
    Match.when(
      ({ depth }) => depth >= maximumDepth,
      ({ depth }) =>
        Option.some(
          `Caara delegation depth ${depth} reached the configured maximum ${maximumDepth}; refusing to start another ${harnessDisplayName(target)} harness.`,
        ),
    ),
    Match.orElse(() => Option.none()),
  );

/**
 * Enforces the delegation policy for one turn before any harness starts: the immediate caller may
 * not target its own harness, and a harness may not be spawned once the configured depth is
 * reached. Non-harness targets, such as Diagnostic, spawn nothing and are always allowed.
 */
export const enforceDelegationPolicy = ({
  delegation,
  externalAgentKind,
  maximumDepth,
}: {
  readonly delegation: AgentTurnDelegation;
  readonly externalAgentKind: string;
  readonly maximumDepth: number;
}): EffectContract<void, AgentDriverError> =>
  Option.match(
    Option.fromUndefinedOr(caaraHarnessFromExternalAgentKind(externalAgentKind)).pipe(
      Option.flatMap((target) => delegationRejection({ delegation, target, maximumDepth })),
    ),
    {
      onNone: () => Effect.void,
      onSome: (message) => Effect.fail(createInvalidPromptAgentDriverError({ message })),
    },
  );

/**
 * Builds the delegation markers Caara injects into a spawned harness environment: the harness
 * itself as the next immediate caller, and the incremented depth.
 */
export const delegationChildEnvironment = ({
  delegation,
  harness,
}: {
  readonly delegation: AgentTurnDelegation;
  readonly harness: CaaraHarness;
}): Readonly<Record<string, string>> => ({
  [caaraHarnessEnvironmentVariable()]: harness,
  [caaraDelegationDepthEnvironmentVariable()]: String(delegation.depth + 1),
});
