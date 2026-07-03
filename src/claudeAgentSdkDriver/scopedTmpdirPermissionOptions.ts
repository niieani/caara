import path from "node:path";

import type { Options as ClaudeQueryOptions, Settings } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Match, Option } from "effect";

import type { CaaraExecutionPathEnvironment } from "../caaraExecutionPath.ts";
import { parseClaudeToolList } from "../claudeInteractionPolicy.ts";
import {
  createInvalidPromptAgentDriverError,
  type AgentDriverError,
} from "../mockResponsesProvider/agentDriver.ts";

/** Permission settings shape accepted by Claude Code settings. */
type ClaudePermissionSettings = NonNullable<Settings["permissions"]>;

/** Builds an explicit Claude SDK driver option validation failure. */
const optionError = (message: string): AgentDriverError =>
  createInvalidPromptAgentDriverError({ message });

/** One Claude permission rule split into tool name and rule specifier. */
interface ClaudePermissionRuleParts {
  readonly toolName: string;
  readonly specifier: string;
}

/** Returns a fresh matcher for the only supported scoped Claude placeholder. */
const tmpdirPlaceholderPattern = (): RegExp => /\$(?:\{TMPDIR\}|TMPDIR(?![A-Za-z0-9_]))/gu;

/** Returns a fresh matcher for unsupported shell-like dollar expansions in scoped Claude options. */
const unsupportedScopedEnvironmentPlaceholderPattern = (): RegExp =>
  /\$(?!(?:\{TMPDIR\}|TMPDIR(?![A-Za-z0-9_])))(?:\{[^}]*\}|\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*|.)?/gu;

/** Finds the first unsupported environment placeholder in a scoped Claude option value. */
const unsupportedScopedEnvironmentPlaceholder = ({
  value,
}: {
  readonly value: string;
}): Option.Option<string> =>
  Option.fromUndefinedOr(
    Array.from(value.matchAll(unsupportedScopedEnvironmentPlaceholderPattern())).at(0),
  ).pipe(Option.map((match) => match[0] ?? "$"));

/** Returns true when a value contains a supported TMPDIR placeholder. */
const containsTmpdirPlaceholder = (value: string): boolean =>
  Array.from(value.matchAll(tmpdirPlaceholderPattern())).length > 0;

/** Fails when a scoped Claude option contains unsupported shell-like placeholders. */
const validateScopedEnvironmentPlaceholders = Effect.fnUntraced(function* ({
  optionName,
  value,
}: {
  readonly optionName: string;
  readonly value: string;
}) {
  return yield* Option.match(unsupportedScopedEnvironmentPlaceholder({ value }), {
    onNone: () => Effect.void,
    onSome: (placeholder) =>
      optionError(
        `Unsupported environment placeholder in Claude Agent SDK ${optionName}: ${placeholder}. Only $TMPDIR and \${TMPDIR} are supported.`,
      ),
  });
});

/** Removes trailing path separators from TMPDIR while preserving the root directory. */
const normalizeTmpdir = (tmpdir: string): string => tmpdir.replace(/\/+$/u, "") || "/";

/** Validates that a TMPDIR value is absolute and returns the normalized directory. */
const validateAbsoluteScopedTmpdir = ({
  optionName,
  rawTmpdir,
}: {
  readonly optionName: string;
  readonly rawTmpdir: string;
}) =>
  Match.value(path.isAbsolute(rawTmpdir)).pipe(
    Match.when(true, () => Effect.succeed(normalizeTmpdir(rawTmpdir))),
    Match.orElse(() =>
      optionError(
        `Claude Agent SDK ${optionName} requires an absolute TMPDIR, but TMPDIR is relative: ${rawTmpdir}.`,
      ),
    ),
  );

/** Resolves the current absolute TMPDIR for a scoped Claude option. */
const resolveScopedTmpdir = Effect.fnUntraced(function* ({
  optionName,
  processEnvironment,
}: {
  readonly optionName: string;
  readonly processEnvironment: CaaraExecutionPathEnvironment;
}) {
  return yield* Option.match(Option.fromUndefinedOr(processEnvironment.TMPDIR), {
    onNone: () =>
      optionError(`Claude Agent SDK ${optionName} requires TMPDIR, but TMPDIR is missing.`),
    onSome: (rawTmpdir) =>
      Match.value(rawTmpdir.length).pipe(
        Match.when(0, () =>
          optionError(`Claude Agent SDK ${optionName} requires TMPDIR, but TMPDIR is empty.`),
        ),
        Match.orElse(() => validateAbsoluteScopedTmpdir({ optionName, rawTmpdir })),
      ),
  });
});

/** Replaces all supported TMPDIR placeholders in a scoped Claude value. */
const replaceScopedTmpdirPlaceholders = ({
  tmpdir,
  value,
}: {
  readonly tmpdir: string;
  readonly value: string;
}): string => value.replace(tmpdirPlaceholderPattern(), tmpdir);

/** Expands supported TMPDIR placeholders in one scoped Claude option value. */
const expandScopedTmpdirPlaceholders = Effect.fnUntraced(function* ({
  optionName,
  processEnvironment,
  value,
}: {
  readonly optionName: string;
  readonly processEnvironment: CaaraExecutionPathEnvironment;
  readonly value: string;
}) {
  yield* validateScopedEnvironmentPlaceholders({ optionName, value });
  return yield* Option.match(
    Option.fromUndefinedOr([value].filter(containsTmpdirPlaceholder).at(0)),
    {
      onNone: () => Effect.succeed(value),
      onSome: (nextValue) =>
        Effect.map(resolveScopedTmpdir({ optionName, processEnvironment }), (tmpdir) =>
          replaceScopedTmpdirPlaceholders({ tmpdir, value: nextValue }),
        ),
    },
  );
});

/** Validates one Claude SDK additional directory after scoped placeholder expansion. */
const validateAdditionalDirectory = ({ directory }: { readonly directory: string }) =>
  Match.value(path.isAbsolute(directory)).pipe(
    Match.when(true, () => Effect.succeed(directory)),
    Match.orElse(() =>
      optionError(
        `Claude Agent SDK additional_directories entries must be absolute: ${directory}.`,
      ),
    ),
  );

/** Parses the optional comma-delimited Claude SDK additional-directories query parameter. */
export const parseClaudeAdditionalDirectoriesOption = Effect.fnUntraced(function* ({
  processEnvironment,
  value,
}: {
  readonly processEnvironment: CaaraExecutionPathEnvironment;
  readonly value: string | undefined;
}) {
  return yield* Option.match(Option.fromUndefinedOr(value), {
    onNone: () => Effect.map(Effect.void, () => undefined),
    onSome: (rawValue) => {
      const directories = parseClaudeToolList(rawValue);
      return Option.match(
        Option.fromUndefinedOr([directories].filter((list) => list.length > 0).at(0)),
        {
          onNone: () => Effect.map(Effect.void, () => undefined),
          onSome: (directoryList) =>
            Effect.forEach(directoryList, (directory) =>
              expandScopedTmpdirPlaceholders({
                optionName: "additional_directories",
                processEnvironment,
                value: directory,
              }).pipe(
                Effect.flatMap((expanded) => validateAdditionalDirectory({ directory: expanded })),
              ),
            ),
        },
      );
    },
  });
});

/** Splits a Claude tool rule into name and specifier when the tool uses `Name(...)` syntax. */
const splitClaudePermissionRule = (tool: string): Option.Option<ClaudePermissionRuleParts> => {
  const specifierStart = tool.indexOf("(");
  return Match.value(specifierStart > 0 && tool.endsWith(")")).pipe(
    Match.when(true, () =>
      Option.some({
        toolName: tool.slice(0, specifierStart),
        specifier: tool.slice(specifierStart + 1, -1),
      }),
    ),
    Match.orElse(() => Option.none()),
  );
};

/** Converts absolute filesystem rule specifiers into Claude's double-slash absolute syntax. */
const claudeAbsolutePermissionRuleSpecifier = (specifier: string): string =>
  Match.value(specifier.startsWith("/") && !specifier.startsWith("//")).pipe(
    Match.when(true, () => `/${specifier}`),
    Match.orElse(() => specifier),
  );

/** Rejects placeholders used outside a Claude tool rule specifier. */
const validateNoToolNamePlaceholder = Effect.fnUntraced(function* ({
  optionName,
  toolName,
}: {
  readonly optionName: string;
  readonly toolName: string;
}) {
  yield* validateScopedEnvironmentPlaceholders({ optionName, value: toolName });
  return yield* Option.match(
    Option.fromUndefinedOr([toolName].filter(containsTmpdirPlaceholder).at(0)),
    {
      onNone: () => Effect.void,
      onSome: () =>
        optionError(
          `Claude Agent SDK ${optionName} TMPDIR placeholders are only supported inside tool rule specifiers.`,
        ),
    },
  );
});

/** Expands TMPDIR placeholders only inside one Claude tool permission rule specifier. */
export const expandClaudePermissionToolRule = Effect.fnUntraced(function* ({
  optionName,
  processEnvironment,
  tool,
}: {
  readonly optionName: string;
  readonly processEnvironment: CaaraExecutionPathEnvironment;
  readonly tool: string;
}) {
  return yield* Option.match(splitClaudePermissionRule(tool), {
    onNone: () =>
      validateNoToolNamePlaceholder({ optionName, toolName: tool }).pipe(Effect.map(() => tool)),
    onSome: (parts) =>
      validateNoToolNamePlaceholder({ optionName, toolName: parts.toolName }).pipe(
        Effect.flatMap(() =>
          expandScopedTmpdirPlaceholders({
            optionName,
            processEnvironment,
            value: parts.specifier,
          }),
        ),
        Effect.map(claudeAbsolutePermissionRuleSpecifier),
        Effect.map((specifier) => `${parts.toolName}(${specifier})`),
      ),
  });
});

/** Builds Claude SDK settings for permission rule allow/deny lists. */
export const permissionRuleSettingsQueryOptions = ({
  allowedPermissionRules,
  deniedPermissionRules,
}: {
  readonly allowedPermissionRules: readonly string[] | undefined;
  readonly deniedPermissionRules: readonly string[] | undefined;
}): Readonly<Partial<Pick<ClaudeQueryOptions, "settings">>> => {
  const allow = Option.match(Option.fromUndefinedOr(allowedPermissionRules), {
    onNone: () => ({}),
    onSome: (rules) => ({ allow: [...rules] }),
  });
  const deny = Option.match(Option.fromUndefinedOr(deniedPermissionRules), {
    onNone: () => ({}),
    onSome: (rules) => ({ deny: [...rules] }),
  });
  const permissions = {
    ...allow,
    ...deny,
  } satisfies ClaudePermissionSettings;

  return Match.value(Object.keys(permissions).length).pipe(
    Match.when(0, () => ({})),
    Match.orElse(() => ({ settings: { permissions } satisfies Settings })),
  );
};
