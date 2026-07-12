import fs from "node:fs/promises";
import path from "node:path";

import { Console, Effect, Match, Schema } from "effect";

import { pathExists } from "./fsPathExists.ts";

/** Environment values used to locate Claude's personal skills directory. */
export interface ClaudePortableGuidanceEnvironment {
  readonly HOME?: string;
  readonly [name: string]: string | undefined;
}

/** Failure while managing Claude's Caara portable-guidance skill. */
export class ClaudePortableGuidanceError extends Schema.TaggedErrorClass<ClaudePortableGuidanceError>()(
  "ClaudePortableGuidanceError",
  { message: Schema.String },
) {}

/** Stable ownership marker embedded in every Caara-managed Claude skill. */
export const claudePortableGuidanceMarker = (): string =>
  "<!-- caara:managed:claude-portable-guidance -->";

/** Renders Claude's auto-discoverable portable blind-delegation skill. */
export const renderClaudePortableGuidance = (): string =>
  [
    "---",
    "name: caara-delegate",
    "description: Delegate work blindly through Caara to a different model family, including Antigravity, while exposing only the human observation link and terminal final answer.",
    "---",
    "",
    claudePortableGuidanceMarker(),
    "",
    "# Caara portable blind delegation",
    "",
    "Use this workflow when asked to delegate through Caara. It is the complete CLI workflow; do not use Claude's native subagent facility for it.",
    "",
    "1. Select an explicit different-family target. For Antigravity use `agy/gemini-3.5-flash`. Select an absolute working directory.",
    "2. Write arbitrary or multiline task text to a file without interpolating it into shell syntax.",
    "3. Run `caara agent start --json --target agy/gemini-3.5-flash --cwd CWD --prompt-file PROMPT_FILE`. Accepted starts exit 10. Parse its JSON and immediately show `observationUrl` to the user as a clickable human-only link.",
    "4. Never open, fetch, inspect, or summarize `observationUrl`. Never pass it to another tool or model. It is a bearer capability containing private agent activity.",
    "5. Repeatedly run `caara agent wait --json --timeout-millis 30000 TURN_ID`. Exit 11 means working; wait again. At terminal completion consume only `finalAnswer`, never reasoning, tool activity, transcript, or viewer HTML.",
    "6. To stop, run `caara agent cancel --json TURN_ID`. Successful cancellation exits 12. Honor `sessionReusable` before a follow-up using `--session-id`.",
    "",
  ].join("\n");

/** Resolves the official personal Claude skill path. */
export const defaultClaudePortableGuidancePath = ({
  env,
}: {
  readonly env: ClaudePortableGuidanceEnvironment;
}): string => {
  const home = Match.value(env.HOME).pipe(
    Match.when(
      (value): value is string => value !== undefined && value.length > 0,
      (value) => value,
    ),
    Match.orElse(() => {
      throw new ClaudePortableGuidanceError({
        message: "HOME is required to locate Claude's personal skills directory.",
      });
    }),
  );
  return path.join(home, ".claude", "skills", "caara-delegate", "SKILL.md");
};

/** Result returned by a Claude guidance lifecycle operation. */
export interface ClaudePortableGuidanceResult {
  readonly path: string;
  readonly removed: boolean;
}

/** Rejects unexpected positional input to a no-argument guidance command. */
const requireNoGuidanceArgs = ({
  args,
  command,
}: {
  readonly args: readonly string[];
  readonly command: string;
}) => {
  const hasArguments = Effect.succeed(args.length !== 0);
  return Effect.fail(
    new ClaudePortableGuidanceError({ message: `${command} accepts no arguments.` }),
  ).pipe(Effect.when(hasArguments), Effect.asVoid);
};

/** Reads a present guidance file through the typed lifecycle error. */
const readExistingGuidance = Effect.fnUntraced(function* ({
  filePath,
}: {
  readonly filePath: string;
}) {
  const exists = yield* pathExists({ targetPath: filePath });
  if (!exists) return undefined;
  return yield* Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (cause) =>
      new ClaudePortableGuidanceError({
        message: `Failed to read Claude guidance at ${filePath}: ${String(cause)}`,
      }),
  });
});

/** Requires an existing Claude skill to carry Caara's ownership marker. */
const requireCaaraOwnership = ({
  filePath,
  source,
}: {
  readonly filePath: string;
  readonly source: string;
}) => {
  const unmarked = Effect.succeed(!source.includes(claudePortableGuidanceMarker()));
  return Effect.fail(
    new ClaudePortableGuidanceError({
      message: `Refusing to modify unmarked Claude skill at ${filePath}.`,
    }),
  ).pipe(Effect.when(unmarked), Effect.asVoid);
};

/** Removes one present and marker-owned Claude guidance file. */
const removePresentGuidance = Effect.fnUntraced(function* ({
  filePath,
  source,
}: {
  readonly filePath: string;
  readonly source: string;
}) {
  yield* requireCaaraOwnership({ filePath, source });
  yield* Effect.tryPromise({
    try: () => fs.rm(filePath),
    catch: (cause) =>
      new ClaudePortableGuidanceError({
        message: `Failed to remove Claude guidance at ${filePath}: ${String(cause)}`,
      }),
  });
  return { path: filePath, removed: true } satisfies ClaudePortableGuidanceResult;
});

/** Installs or refreshes the Caara-owned personal Claude skill. */
export const installClaudePortableGuidance = Effect.fnUntraced(function* ({
  env = process.env,
}: {
  readonly env?: ClaudePortableGuidanceEnvironment;
} = {}) {
  const filePath = defaultClaudePortableGuidancePath({ env });
  const existing = yield* readExistingGuidance({ filePath });
  yield* Effect.forEach(
    [existing].filter((source): source is string => source !== undefined),
    (source) => requireCaaraOwnership({ filePath, source }),
    { discard: true },
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(filePath), { recursive: true }),
    catch: (cause) =>
      new ClaudePortableGuidanceError({
        message: `Failed to create Claude guidance directory at ${filePath}: ${String(cause)}`,
      }),
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(filePath, renderClaudePortableGuidance(), "utf8"),
    catch: (cause) =>
      new ClaudePortableGuidanceError({
        message: `Failed to install Claude guidance at ${filePath}: ${String(cause)}`,
      }),
  });
  return { path: filePath, removed: false } satisfies ClaudePortableGuidanceResult;
});

/** Removes only a marker-owned Caara Claude skill, preserving all other Claude state. */
export const uninstallClaudePortableGuidance = Effect.fnUntraced(function* ({
  env = process.env,
}: {
  readonly env?: ClaudePortableGuidanceEnvironment;
} = {}) {
  const filePath = defaultClaudePortableGuidancePath({ env });
  const existing = yield* readExistingGuidance({ filePath });
  return yield* Match.value(existing).pipe(
    Match.when(undefined, () =>
      Effect.succeed({ path: filePath, removed: false } satisfies ClaudePortableGuidanceResult),
    ),
    Match.orElse((source) => removePresentGuidance({ filePath, source })),
  );
});

/** Runs the live install command and prints its owned artifact path. */
export const runCaaraInstallClaudeGuidanceCli = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  yield* requireNoGuidanceArgs({ args, command: "install-claude-guidance" });
  const result = yield* installClaudePortableGuidance();
  yield* Console.log(`installed Claude portable guidance at ${result.path}`);
});

/** Runs the live uninstall command and prints its ownership-safe result. */
export const runCaaraUninstallClaudeGuidanceCli = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  yield* requireNoGuidanceArgs({ args, command: "uninstall-claude-guidance" });
  const result = yield* uninstallClaudePortableGuidance();
  yield* Console.log(
    Match.value(result.removed).pipe(
      Match.when(true, () => `removed Claude portable guidance at ${result.path}`),
      Match.orElse(() => `Claude portable guidance already absent at ${result.path}`),
    ),
  );
});
