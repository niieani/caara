import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { TOML } from "bun";
import { Effect, Schema } from "effect";

/** Absolute path to the checked-in Claude-backed Codex role config. */
const caaraClaudeRolePath = path.join(
  import.meta.dirname,
  "..",
  "..",
  ".codex",
  "agents",
  "caara-claude.toml",
);

/** Tagged failure for checked-in role TOML parse errors. */
class CaaraClaudeRoleConfigTestError extends Schema.TaggedErrorClass<CaaraClaudeRoleConfigTestError>()(
  "CaaraClaudeRoleConfigTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown role config parse failures into a tagged test error. */
const caaraClaudeRoleConfigTestError = (cause: unknown): CaaraClaudeRoleConfigTestError =>
  new CaaraClaudeRoleConfigTestError({ message: String(cause) });

/** Minimal checked-in role query params needed for scoped smoke writes. */
const CaaraClaudeRoleQueryParams = Schema.Struct({
  additional_directories: Schema.String,
  allowed_tools: Schema.String,
  permission_mode: Schema.String,
});

/** Minimal checked-in role config shape asserted by the scoped smoke test. */
const CaaraClaudeRoleConfig = Schema.Struct({
  model_providers: Schema.Struct({
    caara: Schema.Struct({
      query_params: CaaraClaudeRoleQueryParams,
    }),
  }),
});

/** Reads and validates the checked-in Claude-backed Codex role config. */
const readCaaraClaudeRoleConfig = Effect.fnUntraced(function* () {
  const source = yield* Effect.promise(() => Bun.file(caaraClaudeRolePath).text());
  const parsed = yield* Effect.try({
    try: () => TOML.parse(source),
    catch: caaraClaudeRoleConfigTestError,
  });
  const config = yield* Schema.decodeUnknownEffect(CaaraClaudeRoleConfig)(parsed);
  return { config, source };
});

describe("caara-claude role config", () => {
  it.effect("configures scoped TMPDIR smoke write permissions without dangerous bypass", () =>
    Effect.gen(function* () {
      const { config, source } = yield* readCaaraClaudeRoleConfig();
      const queryParams = config.model_providers.caara.query_params;

      assert.strictEqual(queryParams.permission_mode, "dontAsk");
      assert.strictEqual(queryParams.additional_directories, "$TMPDIR");
      assert.deepStrictEqual(
        new Set(queryParams.allowed_tools.split(",")),
        new Set(["Write($TMPDIR/caara-panel/smoke/**)", "Edit($TMPDIR/caara-panel/smoke/**)"]),
      );
      assert.ok(!/Bash\(/u.test(queryParams.allowed_tools));
      assert.ok(!/bypassPermissions|allow-dangerous-skip-permissions/u.test(source));
    }),
  );
});
