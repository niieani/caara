import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  defaultDelegationMaximumDepth,
  delegationChildEnvironment,
  enforceDelegationPolicy,
  resolveDelegationFromCodexResponsesHeaders,
  resolveDelegationFromEnvironment,
  resolveDelegationFromPortableHeaders,
} from "./agentDelegation.ts";

describe("resolveDelegationFromEnvironment", () => {
  it.effect("treats an environment without markers as direct invocation", () =>
    Effect.gen(function* () {
      const delegation = yield* resolveDelegationFromEnvironment({ env: { HOME: "/home/me" } });
      assert.deepStrictEqual(delegation, { caller: undefined, depth: 0 });
    }),
  );

  it.effect("derives the caller from one verified native host marker", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* resolveDelegationFromEnvironment({ env: { CLAUDECODE: "1" } }),
        {
          caller: "claude",
          depth: 0,
        },
      );
      assert.deepStrictEqual(
        yield* resolveDelegationFromEnvironment({ env: { CODEX_THREAD_ID: "thread-1" } }),
        { caller: "codex", depth: 0 },
      );
    }),
  );

  it.effect("prefers Caara's injected marker over inherited native markers", () =>
    Effect.gen(function* () {
      const delegation = yield* resolveDelegationFromEnvironment({
        env: {
          CAARA_HARNESS: "agy",
          CAARA_DELEGATION_DEPTH: "2",
          CLAUDECODE: "1",
          CODEX_THREAD_ID: "thread-1",
        },
      });
      assert.deepStrictEqual(delegation, { caller: "agy", depth: 2 });
    }),
  );

  it.effect("accepts a guidance-set harness marker without depth as depth 0", () =>
    Effect.gen(function* () {
      const delegation = yield* resolveDelegationFromEnvironment({
        env: { CAARA_HARNESS: "agy" },
      });
      assert.deepStrictEqual(delegation, { caller: "agy", depth: 0 });
    }),
  );

  it.effect("fails explicitly on malformed and conflicting markers", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [Readonly<Record<string, string>>, RegExp]> = [
        [{ CAARA_DELEGATION_DEPTH: "1" }, /CAARA_DELEGATION_DEPTH is set without CAARA_HARNESS/u],
        [{ CAARA_HARNESS: "gemini" }, /Malformed CAARA_HARNESS/u],
        [{ CAARA_HARNESS: "claude", CAARA_DELEGATION_DEPTH: "-1" }, /CAARA_DELEGATION_DEPTH/u],
        [{ CAARA_HARNESS: "claude", CAARA_DELEGATION_DEPTH: "01" }, /CAARA_DELEGATION_DEPTH/u],
        [{ CAARA_HARNESS: "claude", CAARA_DELEGATION_DEPTH: "1.5" }, /CAARA_DELEGATION_DEPTH/u],
        [{ CLAUDECODE: "true" }, /Malformed native CLAUDECODE/u],
        [{ CODEX_THREAD_ID: "" }, /Malformed native CODEX_THREAD_ID/u],
        [{ CLAUDECODE: "1", CODEX_THREAD_ID: "thread-1" }, /Conflicting native harness markers/u],
      ];
      for (const [env, message] of cases) {
        const error = yield* Effect.flip(resolveDelegationFromEnvironment({ env }));
        assert.strictEqual(error._tag, "DelegationMarkerError");
        assert.match(error.message, message);
      }
    }),
  );
});

describe("transport header resolution", () => {
  it.effect("treats a raw portable call without Caara headers as direct", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolveDelegationFromPortableHeaders({ headers: {} }), {
        caller: undefined,
        depth: 0,
      });
      assert.deepStrictEqual(
        yield* resolveDelegationFromPortableHeaders({
          headers: { "x-caara-harness": "claude", "x-caara-delegation-depth": "1" },
        }),
        { caller: "claude", depth: 1 },
      );
    }),
  );

  it.effect("verifies Codex as the Responses caller and rejects contradicting markers", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolveDelegationFromCodexResponsesHeaders({ headers: {} }), {
        caller: "codex",
        depth: 0,
      });
      assert.deepStrictEqual(
        yield* resolveDelegationFromCodexResponsesHeaders({
          headers: { "x-caara-harness": "codex", "x-caara-delegation-depth": "2" },
        }),
        { caller: "codex", depth: 2 },
      );
      const error = yield* Effect.flip(
        resolveDelegationFromCodexResponsesHeaders({ headers: { "x-caara-harness": "claude" } }),
      );
      assert.match(error.message, /Conflicting delegation markers/u);
    }),
  );
});

describe("enforceDelegationPolicy", () => {
  it.effect("rejects only an immediate caller/target match, naming the native alternative", () =>
    Effect.gen(function* () {
      const expectations = [
        ["claude", /Claude Code's native subagents \(the Agent tool\)/u],
        ["agy", /Antigravity's native subagents/u],
        ["codex", /Codex's native subagents \(spawn_agent\)/u],
      ] as const;
      for (const [harness, message] of expectations) {
        const error = yield* Effect.flip(
          enforceDelegationPolicy({
            delegation: { caller: harness, depth: 1 },
            externalAgentKind: harness,
            maximumDepth: 3,
          }),
        );
        assert.match(error.message, message);
      }
    }),
  );

  it.effect("allows cross-harness nesting with repeated non-adjacent harnesses", () =>
    Effect.gen(function* () {
      const chain = [
        { delegation: { caller: undefined, depth: 0 }, target: "codex" },
        { delegation: { caller: "codex", depth: 1 }, target: "claude" },
        { delegation: { caller: "claude", depth: 2 }, target: "codex" },
      ] as const;
      for (const { delegation, target } of chain) {
        yield* enforceDelegationPolicy({ delegation, externalAgentKind: target, maximumDepth: 3 });
      }
    }),
  );

  it.effect("allows three harness entries and rejects the fourth at the default depth", () =>
    Effect.gen(function* () {
      yield* enforceDelegationPolicy({
        delegation: { caller: "claude", depth: 2 },
        externalAgentKind: "codex",
        maximumDepth: defaultDelegationMaximumDepth,
      });
      const fourth = yield* Effect.flip(
        enforceDelegationPolicy({
          delegation: { caller: "codex", depth: 3 },
          externalAgentKind: "claude",
          maximumDepth: defaultDelegationMaximumDepth,
        }),
      );
      assert.match(fourth.message, /depth 3 reached the configured maximum 3/u);
    }),
  );

  it.effect("honours a configured maximum depth", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        enforceDelegationPolicy({
          delegation: { caller: "codex", depth: 1 },
          externalAgentKind: "claude",
          maximumDepth: 1,
        }),
      );
      assert.match(error.message, /configured maximum 1/u);
    }),
  );

  it.effect("never limits non-harness targets", () =>
    enforceDelegationPolicy({
      delegation: { caller: "codex", depth: 99 },
      externalAgentKind: "diagnostic",
      maximumDepth: 3,
    }),
  );
});

describe("delegationChildEnvironment", () => {
  it("injects the spawned harness and the incremented depth", () => {
    assert.deepStrictEqual(
      delegationChildEnvironment({ delegation: { caller: "codex", depth: 1 }, harness: "claude" }),
      { CAARA_HARNESS: "claude", CAARA_DELEGATION_DEPTH: "2" },
    );
  });
});
