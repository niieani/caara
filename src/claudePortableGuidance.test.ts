import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  claudePortableGuidanceMarker,
  defaultClaudePortableGuidancePath,
  installClaudePortableGuidance,
  renderClaudePortableGuidance,
  uninstallClaudePortableGuidance,
} from "./claudePortableGuidance.ts";

/** Builds an isolated fake Claude home under the project staging directory. */
const fixtureRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-12", `claude-guidance-${randomUUID()}`);

/** Tests the complete managed Claude skill lifecycle and collision contract. */
describe("Claude portable guidance", () => {
  it("renders an auto-discoverable blind-delegation skill targeting real Antigravity", () => {
    const source = renderClaudePortableGuidance();

    assert.match(source, /^---\nname: caara-delegate\n/u);
    assert.match(source, /description: Delegat/iu);
    assert.match(source, /agy\/gemini-3\.5-flash/u);
    assert.match(source, /caara agent start --json/u);
    assert.match(source, /--prompt-file/u);
    assert.match(source, /immediately.+observationUrl/isu);
    assert.match(source, /never open, fetch, inspect, or summarize/iu);
    assert.match(source, /caara agent wait --json/u);
    assert.match(source, /finalAnswer/u);
    assert.match(source, /do not use Claude's native subagent facility/iu);
    assert.ok(source.includes(claudePortableGuidanceMarker()));
  });

  it.effect("installs, updates idempotently, and removes only the Caara-owned skill", () =>
    Effect.gen(function* () {
      const home = fixtureRoot();
      const skillPath = defaultClaudePortableGuidancePath({ env: { HOME: home } });
      const siblingPath = path.join(home, ".claude", "skills", "mine", "SKILL.md");
      yield* Effect.tryPromise(() => fs.mkdir(path.dirname(siblingPath), { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(siblingPath, "mine\n", "utf8"));

      const first = yield* installClaudePortableGuidance({ env: { HOME: home } });
      const firstSource = yield* Effect.tryPromise(() => fs.readFile(skillPath, "utf8"));
      const second = yield* installClaudePortableGuidance({ env: { HOME: home } });
      const secondSource = yield* Effect.tryPromise(() => fs.readFile(skillPath, "utf8"));

      assert.strictEqual(first.path, skillPath);
      assert.strictEqual(second.path, skillPath);
      assert.strictEqual(firstSource, secondSource);
      assert.strictEqual(
        yield* Effect.tryPromise(() => fs.readFile(siblingPath, "utf8")),
        "mine\n",
      );

      const removed = yield* uninstallClaudePortableGuidance({ env: { HOME: home } });
      assert.strictEqual(removed.path, skillPath);
      assert.strictEqual(removed.removed, true);
      assert.strictEqual(
        yield* Effect.tryPromise(() => fs.readFile(siblingPath, "utf8")),
        "mine\n",
      );
    }),
  );

  it.effect("refuses install and uninstall collisions without changing user content", () =>
    Effect.gen(function* () {
      const home = fixtureRoot();
      const skillPath = defaultClaudePortableGuidancePath({ env: { HOME: home } });
      yield* Effect.tryPromise(() => fs.mkdir(path.dirname(skillPath), { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(skillPath, "user-owned\n", "utf8"));

      const installFailure = yield* Effect.result(
        installClaudePortableGuidance({ env: { HOME: home } }),
      );
      assert.strictEqual(installFailure._tag, "Failure");
      const uninstallFailure = yield* Effect.result(
        uninstallClaudePortableGuidance({ env: { HOME: home } }),
      );
      assert.strictEqual(uninstallFailure._tag, "Failure");
      assert.strictEqual(
        yield* Effect.tryPromise(() => fs.readFile(skillPath, "utf8")),
        "user-owned\n",
      );
    }),
  );

  it("fails explicitly when HOME is unavailable", () => {
    assert.throws(() => defaultClaudePortableGuidancePath({ env: {} }), /HOME/u);
  });
});
