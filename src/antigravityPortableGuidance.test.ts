import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  antigravityPortableGuidanceBeginMarker,
  antigravityPortableGuidanceEndMarker,
  defaultAntigravityPortableGuidancePath,
  installAntigravityPortableGuidance,
  renderAntigravityPortableGuidanceBlock,
  uninstallAntigravityPortableGuidance,
} from "./antigravityPortableGuidance.ts";

/** Builds one isolated Antigravity home under the project staging directory. */
const fixtureRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-12", `antigravity-guidance-${randomUUID()}`);

describe("Antigravity portable guidance", () => {
  it("renders the complete blind CLI workflow targeting Claude without native subagents", () => {
    const source = renderAntigravityPortableGuidanceBlock();

    assert.ok(source.startsWith(antigravityPortableGuidanceBeginMarker()));
    assert.ok(source.endsWith(antigravityPortableGuidanceEndMarker()));
    assert.match(source, /claude\/sonnet/u);
    assert.match(source, /caara agent start --json/u);
    assert.match(source, /--prompt-file/u);
    assert.match(source, /immediately.+observationUrl/isu);
    assert.match(source, /never open, fetch, inspect, or summarize/iu);
    assert.match(source, /caara agent wait --json/u);
    assert.match(source, /finalAnswer/u);
    assert.match(source, /do not use Antigravity's native subagent/iu);
  });

  it.effect("preserves unrelated GEMINI.md content through idempotent install and uninstall", () =>
    Effect.gen(function* () {
      const home = fixtureRoot();
      const filePath = defaultAntigravityPortableGuidancePath({ env: { HOME: home } });
      yield* Effect.tryPromise(() => fs.mkdir(path.dirname(filePath), { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(filePath, "# My rules\n\nKeep this.\n", "utf8"));

      yield* installAntigravityPortableGuidance({ env: { HOME: home } });
      const first = yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
      yield* installAntigravityPortableGuidance({ env: { HOME: home } });
      const second = yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
      assert.strictEqual(first, second);
      assert.match(second, /^# My rules\n\nKeep this\.\n/u);

      const removed = yield* uninstallAntigravityPortableGuidance({ env: { HOME: home } });
      assert.strictEqual(removed.removed, true);
      assert.strictEqual(
        yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8")),
        "# My rules\n\nKeep this.\n",
      );
    }),
  );

  it.effect("deletes GEMINI.md only when its content is exclusively Caara-owned", () =>
    Effect.gen(function* () {
      const home = fixtureRoot();
      const filePath = defaultAntigravityPortableGuidancePath({ env: { HOME: home } });
      yield* installAntigravityPortableGuidance({ env: { HOME: home } });
      yield* uninstallAntigravityPortableGuidance({ env: { HOME: home } });
      const exists = yield* Effect.promise(() => fs.exists(filePath));
      assert.strictEqual(exists, false);
    }),
  );

  it.effect("round-trips unrelated bytes with no newline and arbitrary trailing whitespace", () =>
    Effect.gen(function* () {
      for (const original of ["# no newline", "# spaces\n\n \t\n", "\nleading and trailing\n\n"]) {
        const home = fixtureRoot();
        const filePath = defaultAntigravityPortableGuidancePath({ env: { HOME: home } });
        yield* Effect.tryPromise(() => fs.mkdir(path.dirname(filePath), { recursive: true }));
        yield* Effect.tryPromise(() => fs.writeFile(filePath, original, "utf8"));
        yield* installAntigravityPortableGuidance({ env: { HOME: home } });
        yield* uninstallAntigravityPortableGuidance({ env: { HOME: home } });
        assert.strictEqual(yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8")), original);
      }
    }),
  );

  it.effect("hard-fails corrupt marker shapes without modifying user content", () =>
    Effect.gen(function* () {
      const home = fixtureRoot();
      const filePath = defaultAntigravityPortableGuidancePath({ env: { HOME: home } });
      const corrupt = `user\n${antigravityPortableGuidanceBeginMarker()}\nbroken\n`;
      yield* Effect.tryPromise(() => fs.mkdir(path.dirname(filePath), { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(filePath, corrupt, "utf8"));

      assert.strictEqual(
        (yield* Effect.result(installAntigravityPortableGuidance({ env: { HOME: home } })))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.result(uninstallAntigravityPortableGuidance({ env: { HOME: home } })))._tag,
        "Failure",
      );
      assert.strictEqual(yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8")), corrupt);
    }),
  );

  it.effect("rejects duplicated, reversed, and unmatched marker shapes", () =>
    Effect.gen(function* () {
      const begin = antigravityPortableGuidanceBeginMarker();
      const end = antigravityPortableGuidanceEndMarker();
      for (const corrupt of [`${begin}\n${begin}\n${end}`, `${end}\n${begin}`, `${end}\norphan`]) {
        const home = fixtureRoot();
        const filePath = defaultAntigravityPortableGuidancePath({ env: { HOME: home } });
        yield* Effect.tryPromise(() => fs.mkdir(path.dirname(filePath), { recursive: true }));
        yield* Effect.tryPromise(() => fs.writeFile(filePath, corrupt, "utf8"));
        assert.strictEqual(
          (yield* Effect.result(installAntigravityPortableGuidance({ env: { HOME: home } })))._tag,
          "Failure",
        );
        assert.strictEqual(yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8")), corrupt);
      }
    }),
  );
});
