import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { TOML } from "bun";
import { Effect, Schema } from "effect";

import { runCaaraInstallCodexRoles } from "./codexRoleInstaller.ts";

/** Builds one isolated role installer test root under temp.local. */
const testRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-03", `codex-roles-${randomUUID()}`);

/** Writes one test fixture file and creates its parent directory. */
const writeFile = Effect.fnUntraced(function* ({
  filePath,
  content,
}: {
  readonly filePath: string;
  readonly content: string;
}) {
  yield* Effect.tryPromise(() => fs.mkdir(path.dirname(filePath), { recursive: true }));
  yield* Effect.tryPromise(() => fs.writeFile(filePath, content, "utf8"));
});

/** Writes one executable fixture on the test PATH. */
const writeExecutable = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  yield* writeFile({ filePath, content: "#!/bin/sh\n" });
  yield* Effect.tryPromise(() => fs.chmod(filePath, 0o755));
});

/** Reads one UTF-8 text fixture. */
const readFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
});

/** Lists filenames in one directory in deterministic order. */
const listFilenames = Effect.fnUntraced(function* ({ dirPath }: { readonly dirPath: string }) {
  const entries = yield* Effect.tryPromise(() => fs.readdir(dirPath));
  return entries.toSorted();
});

/** Minimal generated Codex role provider config shape. */
const GeneratedRoleProviderConfig = Schema.Struct({
  name: Schema.String,
  base_url: Schema.String,
  wire_api: Schema.Literal("responses"),
  requires_openai_auth: Schema.Boolean,
  request_max_retries: Schema.Finite,
  stream_max_retries: Schema.Finite,
  query_params: Schema.Record(Schema.String, Schema.String),
});

/** Minimal generated Codex role config shape asserted by installer tests. */
const GeneratedRoleConfig = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  developer_instructions: Schema.String,
  model_provider: Schema.Literal("caara"),
  model: Schema.String,
  model_supports_reasoning_summaries: Schema.Boolean,
  model_providers: Schema.Struct({
    caara: GeneratedRoleProviderConfig,
  }),
});

/** Tagged failure for generated role TOML parse errors. */
class GeneratedRoleConfigTestError extends Schema.TaggedErrorClass<GeneratedRoleConfigTestError>()(
  "GeneratedRoleConfigTestError",
  {
    message: Schema.String,
  },
) {}

/** Converts unknown role config parse failures into a tagged test error. */
const generatedRoleConfigTestError = (cause: unknown): GeneratedRoleConfigTestError =>
  new GeneratedRoleConfigTestError({ message: String(cause) });

/** Parses and validates one generated role TOML file. */
const parseGeneratedRole = Effect.fnUntraced(function* ({
  filePath,
}: {
  readonly filePath: string;
}) {
  const source = yield* readFile({ filePath });
  const parsed = yield* Effect.try({
    try: () => TOML.parse(source),
    catch: generatedRoleConfigTestError,
  });
  const config = yield* Schema.decodeUnknownEffect(GeneratedRoleConfig)(parsed);
  return { config, source };
});

/** Builds a role installer environment with only the fields needed by tests. */
const roleEnv = ({
  codeHome,
  home,
  pathValue,
}: {
  readonly codeHome?: string | undefined;
  readonly home: string;
  readonly pathValue: string;
}) => ({
  CODEX_HOME: codeHome,
  HOME: home,
  PATH: pathValue,
});

/** Expected safe Claude role filenames generated when Claude is available. */
const expectedClaudeRoleFiles = [
  "caara-claude-fable.toml",
  "caara-claude-haiku.toml",
  "caara-claude-opus.toml",
  "caara-claude-sonnet.toml",
] as const;

/** Expected safe Antigravity role filenames generated when agy is available. */
const expectedAntigravityRoleFiles = [
  "caara-agy-claude-opus-4-6.toml",
  "caara-agy-claude-sonnet-4-6.toml",
  "caara-agy-gemini-3-1-pro.toml",
  "caara-agy-gemini-3-5-flash.toml",
  "caara-agy-gpt-oss-120b.toml",
] as const;

/** Expected skipped-driver report when Antigravity is not available. */
const expectedSkippedAntigravity = {
  driverName: "Antigravity",
  executableName: "agy",
  reason: "command not found on PATH",
} as const;

/** Expected skipped-driver report when Claude is not available. */
const expectedSkippedClaude = {
  driverName: "Claude",
  executableName: "claude",
  reason: "command not found on PATH",
} as const;

describe("Caara Codex role installer", () => {
  it.effect("writes safe Claude roles to CODEX_HOME agents by default", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const binDir = path.join(root, "bin");
      const codexHome = path.join(root, "codex-home");
      const targetDirectory = path.join(codexHome, "agents");
      yield* writeExecutable({ filePath: path.join(binDir, "claude") });

      const result = yield* runCaaraInstallCodexRoles({
        args: [],
        env: roleEnv({
          codeHome: codexHome,
          home: path.join(root, "home"),
          pathValue: binDir,
        }),
      });
      const filenames = yield* listFilenames({ dirPath: targetDirectory });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.targetDirectory, targetDirectory);
      assert.deepStrictEqual(filenames, [...expectedClaudeRoleFiles]);
      assert.deepStrictEqual(result.skippedDrivers, [expectedSkippedAntigravity]);
      assert.match(result.message, /installed 4 Codex roles/u);
      assert.match(result.message, /skipped Antigravity/u);
    }),
  );

  it.effect("uses an explicit target directory instead of CODEX_HOME", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const binDir = path.join(root, "bin");
      const explicitTarget = path.join(root, "project", ".codex", "agents");
      yield* writeExecutable({ filePath: path.join(binDir, "claude") });

      const result = yield* runCaaraInstallCodexRoles({
        args: [explicitTarget],
        env: roleEnv({
          codeHome: path.join(root, "codex-home"),
          home: path.join(root, "home"),
          pathValue: binDir,
        }),
      });
      const filenames = yield* listFilenames({ dirPath: explicitTarget });

      assert.strictEqual(result.targetDirectory, explicitTarget);
      assert.deepStrictEqual(filenames, [...expectedClaudeRoleFiles]);
      assert.deepStrictEqual(result.skippedDrivers, [expectedSkippedAntigravity]);
    }),
  );

  it.effect("falls back to HOME .codex agents when CODEX_HOME is absent", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const binDir = path.join(root, "bin");
      const home = path.join(root, "home");
      const targetDirectory = path.join(home, ".codex", "agents");
      yield* writeExecutable({ filePath: path.join(binDir, "claude") });

      const result = yield* runCaaraInstallCodexRoles({
        args: [],
        env: roleEnv({
          home,
          pathValue: binDir,
        }),
      });

      assert.strictEqual(result.targetDirectory, targetDirectory);
    }),
  );

  it.effect("writes short safe Antigravity roles when agy is available", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const binDir = path.join(root, "bin");
      const targetDirectory = path.join(root, "agents");
      yield* writeExecutable({ filePath: path.join(binDir, "agy") });

      const result = yield* runCaaraInstallCodexRoles({
        args: [targetDirectory],
        env: roleEnv({
          home: path.join(root, "home"),
          pathValue: binDir,
        }),
      });
      const filenames = yield* listFilenames({ dirPath: targetDirectory });

      assert.deepStrictEqual(filenames, [...expectedAntigravityRoleFiles]);
      assert.deepStrictEqual(result.skippedDrivers, [expectedSkippedClaude]);
      assert.ok(!filenames.some((filename) => /(?:low|medium|high|thinking)/iu.test(filename)));
      assert.match(result.message, /installed 5 Codex roles/u);
    }),
  );

  it.effect("uses Antigravity model-family slugs instead of exact display names", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const binDir = path.join(root, "bin");
      const targetDirectory = path.join(root, "agents");
      yield* writeExecutable({ filePath: path.join(binDir, "agy") });

      yield* runCaaraInstallCodexRoles({
        args: [targetDirectory],
        env: roleEnv({
          home: path.join(root, "home"),
          pathValue: binDir,
        }),
      });
      const { config, source } = yield* parseGeneratedRole({
        filePath: path.join(targetDirectory, "caara-agy-gemini-3-5-flash.toml"),
      });

      assert.strictEqual(config.name, "caara-agy-gemini-3-5-flash");
      assert.strictEqual(config.model, "agy/gemini-3.5-flash");
      assert.strictEqual(config.model_providers.caara.base_url, "http://127.0.0.1:8787/v1");
      assert.deepStrictEqual(config.model_providers.caara.query_params, {});
      assert.ok(!source.includes("Gemini 3.5 Flash (Low)"));
      assert.ok(!source.includes("Gemini 3.5 Flash (Medium)"));
      assert.ok(!source.includes("Gemini 3.5 Flash (High)"));
      assert.ok(!source.includes("dangerously_skip_permissions"));
      assert.ok(!source.includes("permission_mode"));
    }),
  );

  it.effect(
    "writes mixed Claude and Antigravity catalogs when both executables are available",
    () =>
      Effect.gen(function* () {
        const root = testRoot();
        const binDir = path.join(root, "bin");
        const targetDirectory = path.join(root, "agents");
        yield* writeExecutable({ filePath: path.join(binDir, "claude") });
        yield* writeExecutable({ filePath: path.join(binDir, "agy") });

        const result = yield* runCaaraInstallCodexRoles({
          args: [targetDirectory],
          env: roleEnv({
            home: path.join(root, "home"),
            pathValue: binDir,
          }),
        });
        const filenames = yield* listFilenames({ dirPath: targetDirectory });

        assert.deepStrictEqual(filenames, [
          ...expectedAntigravityRoleFiles,
          ...expectedClaudeRoleFiles,
        ]);
        assert.deepStrictEqual(result.skippedDrivers, []);
        assert.match(result.message, /installed 9 Codex roles/u);
      }),
  );

  it.effect("generates marked parseable safe TOML without a generic Claude alias", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const binDir = path.join(root, "bin");
      const targetDirectory = path.join(root, "agents");
      yield* writeExecutable({ filePath: path.join(binDir, "claude") });

      yield* runCaaraInstallCodexRoles({
        args: [targetDirectory],
        env: roleEnv({
          home: path.join(root, "home"),
          pathValue: binDir,
        }),
      });
      const { config, source } = yield* parseGeneratedRole({
        filePath: path.join(targetDirectory, "caara-claude-haiku.toml"),
      });
      const filenames = yield* listFilenames({ dirPath: targetDirectory });

      assert.strictEqual(config.name, "caara-claude-haiku");
      assert.strictEqual(config.model, "claude/haiku");
      assert.strictEqual(config.model_providers.caara.base_url, "http://127.0.0.1:8787/v1");
      assert.deepStrictEqual(config.model_providers.caara.query_params, {});
      assert.match(source, /Generated by Caara/u);
      assert.ok(!source.includes("additional_directories"));
      assert.ok(!source.includes("allowed_tools"));
      assert.ok(!source.includes("permission_mode"));
      assert.ok(!source.includes("bypassPermissions"));
      assert.ok(!source.includes("dangerously_skip_permissions"));
      assert.ok(!filenames.includes("caara-claude.toml"));
    }),
  );

  it.effect("reports skipped Claude roles when claude is unavailable on PATH", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const targetDirectory = path.join(root, "agents");

      const result = yield* runCaaraInstallCodexRoles({
        args: [targetDirectory],
        env: roleEnv({
          home: path.join(root, "home"),
          pathValue: "",
        }),
      });
      const filenames = yield* listFilenames({ dirPath: targetDirectory });

      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(filenames, []);
      assert.deepStrictEqual(result.skippedDrivers, [
        expectedSkippedClaude,
        expectedSkippedAntigravity,
      ]);
      assert.match(result.message, /skipped Claude/u);
      assert.match(result.message, /skipped Antigravity/u);
    }),
  );
});
