import fs from "node:fs/promises";
import path from "node:path";

import { Console, Effect, Match, Schema } from "effect";

import { pathExists } from "./fsPathExists.ts";

/** Environment values used to locate Antigravity's global rules document. */
export interface AntigravityPortableGuidanceEnvironment {
  readonly HOME?: string;
  readonly [name: string]: string | undefined;
}

/** Failure while safely managing Caara's block inside Antigravity global rules. */
export class AntigravityPortableGuidanceError extends Schema.TaggedErrorClass<AntigravityPortableGuidanceError>()(
  "AntigravityPortableGuidanceError",
  { message: Schema.String },
) {}

/** Stable opening marker for Caara-owned Antigravity guidance. */
export const antigravityPortableGuidanceBeginMarker = (): string =>
  "<!-- caara:managed:antigravity-portable-guidance:begin -->";

/** Stable closing marker for Caara-owned Antigravity guidance. */
export const antigravityPortableGuidanceEndMarker = (): string =>
  "<!-- caara:managed:antigravity-portable-guidance:end -->";

/** Renders the complete Caara-owned blind-delegation rules block. */
export const renderAntigravityPortableGuidanceBlock = (): string =>
  [
    antigravityPortableGuidanceBeginMarker(),
    "",
    "## Caara portable blind delegation",
    "",
    "When asked to delegate through Caara, use this complete CLI workflow. Do not use Antigravity's native subagent tools for Caara delegation.",
    "",
    "1. Select the explicit different-family target `claude/sonnet` and an absolute working directory.",
    "2. Write arbitrary or multiline task text to a file without interpolating it into shell syntax.",
    "3. Run `caara agent start --json --target claude/sonnet --cwd CWD --prompt-file PROMPT_FILE`. Accepted starts exit 10. Parse its JSON and immediately show `observationUrl` to the user as a clickable human-only link.",
    "4. Never open, fetch, inspect, or summarize `observationUrl`. Never pass it to a tool or model. It is a bearer capability containing private agent activity.",
    "5. Repeatedly run `caara agent wait --json --timeout-millis 30000 TURN_ID`. Exit 11 means working; wait again. At terminal completion consume only `finalAnswer`, never reasoning, tool activity, transcript, or viewer HTML.",
    "6. To stop, run `caara agent cancel --json TURN_ID`. Successful cancellation exits 12. Honor `sessionReusable` before a follow-up using `--session-id`.",
    "",
    antigravityPortableGuidanceEndMarker(),
  ].join("\n");

/** Resolves Antigravity's documented global rules path. */
export const defaultAntigravityPortableGuidancePath = ({
  env,
}: {
  readonly env: AntigravityPortableGuidanceEnvironment;
}): string => {
  const home = Match.value(env.HOME).pipe(
    Match.when(
      (value): value is string => value !== undefined && value.length > 0,
      (value) => value,
    ),
    Match.orElse(() => {
      throw new AntigravityPortableGuidanceError({
        message: "HOME is required to locate Antigravity's global GEMINI.md.",
      });
    }),
  );
  return path.join(home, ".gemini", "GEMINI.md");
};

/** Result returned by one Antigravity guidance lifecycle operation. */
export interface AntigravityPortableGuidanceResult {
  readonly path: string;
  readonly removed: boolean;
}

/** Located Caara marker span inside a valid guidance document. */
interface GuidanceSpan {
  readonly start: number;
  readonly end: number;
}

/** Locates exactly one complete marker pair or fails on every corrupt marker shape. */
const locateGuidanceSpan = ({
  source,
  filePath,
}: {
  readonly source: string;
  readonly filePath: string;
}) => {
  const begin = antigravityPortableGuidanceBeginMarker();
  const end = antigravityPortableGuidanceEndMarker();
  const beginIndex = source.indexOf(begin);
  const endIndex = source.indexOf(end);
  const validAbsent = beginIndex === -1 && endIndex === -1;
  const validPresent =
    beginIndex >= 0 &&
    endIndex > beginIndex &&
    source.indexOf(begin, beginIndex + begin.length) === -1 &&
    source.indexOf(end, endIndex + end.length) === -1;
  const span = [{ start: beginIndex, end: endIndex + end.length } satisfies GuidanceSpan].find(
    () => validPresent,
  );
  const invalid = Effect.succeed(!validAbsent && !validPresent);
  const validation = Effect.fail(
    new AntigravityPortableGuidanceError({
      message: `Refusing to modify corrupt Caara guidance markers at ${filePath}.`,
    }),
  ).pipe(Effect.when(invalid), Effect.asVoid);
  return validation.pipe(Effect.map(() => span));
};

/** Reads the global rules document when it exists. */
const readGuidance = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  if (!(yield* pathExists({ targetPath: filePath }))) return undefined;
  return yield* Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (cause) =>
      new AntigravityPortableGuidanceError({
        message: `Failed to read Antigravity guidance at ${filePath}: ${String(cause)}`,
      }),
  });
});

/** Writes one complete global rules document. */
const writeGuidance = Effect.fnUntraced(function* ({
  filePath,
  source,
}: {
  readonly filePath: string;
  readonly source: string;
}) {
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(filePath), { recursive: true }),
    catch: (cause) =>
      new AntigravityPortableGuidanceError({
        message: `Failed to create Antigravity guidance directory at ${filePath}: ${String(cause)}`,
      }),
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(filePath, source, "utf8"),
    catch: (cause) =>
      new AntigravityPortableGuidanceError({
        message: `Failed to write Antigravity guidance at ${filePath}: ${String(cause)}`,
      }),
  });
});

/** Computes an installed document from an optional existing managed span. */
const installedGuidanceSource = ({
  source,
  span,
  block,
}: {
  readonly source: string;
  readonly span: GuidanceSpan | undefined;
  readonly block: string;
}): string =>
  Match.value(span).pipe(
    Match.when(undefined, () => `${source}${block}`),
    Match.orElse(
      (located) => `${source.slice(0, located.start)}${block}${source.slice(located.end)}`,
    ),
  );

/** Installs or refreshes only Caara's marked block in Antigravity's global rules. */
export const installAntigravityPortableGuidance = Effect.fnUntraced(function* ({
  env = process.env,
}: { readonly env?: AntigravityPortableGuidanceEnvironment } = {}) {
  const filePath = defaultAntigravityPortableGuidancePath({ env });
  const existing = (yield* readGuidance({ filePath })) ?? "";
  const span = yield* locateGuidanceSpan({ source: existing, filePath });
  const block = renderAntigravityPortableGuidanceBlock();
  const source = installedGuidanceSource({ source: existing, span, block });
  yield* writeGuidance({ filePath, source });
  return { path: filePath, removed: false } satisfies AntigravityPortableGuidanceResult;
});

/** Removes only Caara's marked block, deleting the file only when exclusively Caara-owned. */
export const uninstallAntigravityPortableGuidance = Effect.fnUntraced(function* ({
  env = process.env,
}: { readonly env?: AntigravityPortableGuidanceEnvironment } = {}) {
  const filePath = defaultAntigravityPortableGuidancePath({ env });
  const existing = yield* readGuidance({ filePath });
  if (existing === undefined)
    return { path: filePath, removed: false } satisfies AntigravityPortableGuidanceResult;
  const span = yield* locateGuidanceSpan({ source: existing, filePath });
  if (span === undefined)
    return { path: filePath, removed: false } satisfies AntigravityPortableGuidanceResult;
  const remaining = `${existing.slice(0, span.start)}${existing.slice(span.end)}`;
  if (remaining.trim().length === 0) {
    yield* Effect.tryPromise({
      try: () => fs.rm(filePath),
      catch: (cause) =>
        new AntigravityPortableGuidanceError({
          message: `Failed to remove Antigravity guidance at ${filePath}: ${String(cause)}`,
        }),
    });
  } else {
    yield* writeGuidance({ filePath, source: remaining });
  }
  return { path: filePath, removed: true } satisfies AntigravityPortableGuidanceResult;
});

/** Rejects positional arguments to one Antigravity guidance command. */
const requireNoGuidanceArgs = ({
  args,
  command,
}: {
  readonly args: readonly string[];
  readonly command: string;
}) => {
  const hasArguments = Effect.succeed(args.length !== 0);
  return Effect.fail(
    new AntigravityPortableGuidanceError({ message: `${command} accepts no arguments.` }),
  ).pipe(Effect.when(hasArguments), Effect.asVoid);
};

/** Runs the Antigravity guidance install command. */
export const runCaaraInstallAntigravityGuidanceCli = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  yield* requireNoGuidanceArgs({ args, command: "install-antigravity-guidance" });
  const result = yield* installAntigravityPortableGuidance();
  yield* Console.log(`installed Antigravity portable guidance at ${result.path}`);
});

/** Runs the ownership-safe Antigravity guidance uninstall command. */
export const runCaaraUninstallAntigravityGuidanceCli = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  yield* requireNoGuidanceArgs({ args, command: "uninstall-antigravity-guidance" });
  const result = yield* uninstallAntigravityPortableGuidance();
  yield* Console.log(
    Match.value(result.removed).pipe(
      Match.when(true, () => `removed Antigravity portable guidance from ${result.path}`),
      Match.orElse(() => `Antigravity portable guidance already absent at ${result.path}`),
    ),
  );
});
