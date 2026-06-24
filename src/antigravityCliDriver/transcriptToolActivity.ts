import path from "node:path";

import { Match, Option } from "effect";

import {
  formatMarkdownInlineCode,
  formatShellCommandActivityText,
} from "../agentActivityMarkdown.ts";
import type { AntigravityTranscriptRecord } from "./transcript.ts";

/** Safe nested Antigravity tool-call args allowed to influence activity text. */
export interface AntigravityToolArgs {
  readonly CommandLine?: string;
  readonly Cwd?: string;
  readonly AbsolutePath?: string;
  readonly DirectoryPath?: string;
  readonly FilePath?: string;
  readonly FilePaths?: readonly string[];
  readonly Pattern?: string;
  readonly Query?: string;
  readonly toolSummary?: string;
  readonly toolAction?: string;
}

/** Safe Antigravity tool metadata fields allowed to influence activity text. */
export interface AntigravityToolMetadata {
  readonly name?: string;
  readonly toolName?: string;
  readonly tool_name?: string;
  readonly type?: string;
  readonly path?: string;
  readonly filePath?: string;
  readonly file_path?: string;
  readonly toolSummary?: string;
  readonly toolAction?: string;
  readonly command?: string;
  readonly args?: AntigravityToolArgs;
}

/** Maximum safe metadata length surfaced in terse activity text. */
const maxActivityMetadataLength = 160;

/** Returns true when an optional string has displayable content. */
const isNonEmptyString = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

/** Returns the first non-empty optional string in a preferred metadata list. */
const firstNonEmptyString = (values: readonly (string | undefined)[]): string | undefined =>
  values.find(isNonEmptyString);

/** Normalizes one metadata value into a single line. */
const singleLineMetadata = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** Returns a repo-relative display path when metadata points inside the current workspace. */
const relativeDisplayPathMetadata = (value: string): string => {
  const relativePath = path.relative(process.cwd(), value);
  return Match.value(relativePath).pipe(
    Match.when("", () => "."),
    Match.when(
      (candidate) => !candidate.startsWith("..") && !path.isAbsolute(candidate),
      (candidate) => candidate,
    ),
    Match.orElse(() => value),
  );
};

/** Returns a repo-relative display path when metadata points inside the current workspace. */
const displayPathMetadata = (value: string): string =>
  Match.value(path.isAbsolute(value)).pipe(
    Match.when(true, () => relativeDisplayPathMetadata(value)),
    Match.orElse(() => value),
  );

/** Returns bounded path metadata, rejecting strings that look like raw JSON payloads. */
const safePathMetadata = (value: string | undefined): string | undefined =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(value).pipe(
      Option.map(singleLineMetadata),
      Option.map(displayPathMetadata),
      Option.filter(
        (metadata) =>
          metadata.length > 0 &&
          metadata.length <= maxActivityMetadataLength &&
          !/[{}]/u.test(metadata),
      ),
    ),
  );

/** Returns a bounded, single-line activity fallback summary when it is visibly terse. */
const safeActivitySummary = (value: string | undefined): string | undefined =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(value).pipe(
      Option.map(singleLineMetadata),
      Option.filter(
        (metadata) =>
          metadata.length > 0 &&
          metadata.length <= maxActivityMetadataLength &&
          !/[{}[\]"]/u.test(metadata),
      ),
    ),
  );

/** Extracts the preferred Antigravity action text from top-level or nested tool metadata. */
const safeToolAction = (metadata: AntigravityToolMetadata): string | undefined =>
  safeActivitySummary(firstNonEmptyString([metadata.toolAction, metadata.args?.toolAction]));

/** Extracts the preferred Antigravity summary text from top-level or nested tool metadata. */
const safeToolSummary = (metadata: AntigravityToolMetadata): string | undefined =>
  safeActivitySummary(firstNonEmptyString([metadata.toolSummary, metadata.args?.toolSummary]));

/** Returns a bounded action/summary fallback before the generic activity phrase. */
const toolActivityFallback = ({
  metadata,
  fallback,
}: {
  readonly metadata: AntigravityToolMetadata;
  readonly fallback: string;
}): string => safeToolAction(metadata) ?? safeToolSummary(metadata) ?? fallback;

/** Extracts safe path-like metadata from an Antigravity transcript tool record. */
const safeToolPath = (metadata: AntigravityToolMetadata): string | undefined =>
  safePathMetadata(
    firstNonEmptyString([
      metadata.file_path,
      metadata.filePath,
      metadata.path,
      metadata.args?.AbsolutePath,
      metadata.args?.FilePath,
      metadata.args?.DirectoryPath,
      metadata.args?.FilePaths?.at(0),
    ]),
  );

/** Formats a safe path-like metadata value as Markdown inline code. */
const pathActivityTarget = (value: string): string => formatMarkdownInlineCode({ text: value });

/** Extracts a safe command string from top-level or nested Antigravity metadata. */
const toolCommand = (metadata: AntigravityToolMetadata): string | undefined =>
  firstNonEmptyString([metadata.command, metadata.args?.CommandLine]);

/** Builds command activity text that matches Claude Bash command formatting. */
const runCommandActivityText = (metadata: AntigravityToolMetadata): string =>
  formatShellCommandActivityText({
    label: "Running command",
    command: toolCommand(metadata),
    fallback: toolActivityFallback({ metadata, fallback: "Running command" }),
  });

/** Extracts the preferred Antigravity tool name from safe metadata fields. */
const toolName = (metadata: AntigravityToolMetadata): string | undefined =>
  firstNonEmptyString([metadata.name, metadata.toolName, metadata.tool_name, metadata.type]);

/** Returns a bounded safe tool name for generic activity fallbacks. */
const safeToolName = (metadata: AntigravityToolMetadata): string =>
  safeActivitySummary(toolName(metadata)) ?? "tool";

/** Canonicalizes one Antigravity tool name for stable activity matching. */
const normalizedToolName = (metadata: AntigravityToolMetadata): string =>
  Match.value(
    safeToolName(metadata)
      .replace(/[\s-]+/gu, "_")
      .toUpperCase(),
  ).pipe(
    Match.when("LIST_DIR", () => "LIST_DIRECTORY"),
    Match.when("READ_FILE", () => "VIEW_FILE"),
    Match.orElse((name) => name),
  );

/** Extracts a safe search target from path or query metadata. */
const safeSearchTarget = (metadata: AntigravityToolMetadata): string | undefined =>
  safeToolPath(metadata) ??
  safeActivitySummary(firstNonEmptyString([metadata.args?.Query, metadata.args?.Pattern]));

/** Builds the user-facing activity phrase for one safe Antigravity tool metadata subset. */
export const toolActivityText = (metadata: AntigravityToolMetadata): string => {
  const pathMetadata = safeToolPath(metadata);
  return Match.value(normalizedToolName(metadata)).pipe(
    Match.when("LIST_DIRECTORY", () =>
      Option.match(Option.fromUndefinedOr(pathMetadata), {
        onNone: () => toolActivityFallback({ metadata, fallback: "Listing directory" }),
        onSome: (directory) => `Listing ${pathActivityTarget(directory)}`,
      }),
    ),
    Match.when("VIEW_FILE", () =>
      Option.match(Option.fromUndefinedOr(pathMetadata), {
        onNone: () => toolActivityFallback({ metadata, fallback: "Reading file" }),
        onSome: (filePath) => `Viewing ${pathActivityTarget(filePath)}`,
      }),
    ),
    Match.when("RUN_COMMAND", () => runCommandActivityText(metadata)),
    Match.when("GREP_SEARCH", () =>
      Option.match(Option.fromUndefinedOr(safeSearchTarget(metadata)), {
        onNone: () => toolActivityFallback({ metadata, fallback: "Searching files" }),
        onSome: (target) => `Searching ${pathActivityTarget(target)}`,
      }),
    ),
    Match.orElse(() =>
      toolActivityFallback({
        metadata,
        fallback: `Using ${safeToolName(metadata)}`,
      }),
    ),
  );
};

/** Appends one planner tool call to pending correlation state. */
export const appendPendingToolCall = ({
  pendingToolCalls,
  toolCall,
}: {
  readonly pendingToolCalls: readonly AntigravityToolMetadata[];
  readonly toolCall: AntigravityToolMetadata;
}): readonly AntigravityToolMetadata[] => [...pendingToolCalls, toolCall];

/** Removes the first pending planner tool call matching a completed result row. */
export const takePendingToolCall = ({
  pendingToolCalls,
  record,
}: {
  readonly pendingToolCalls: readonly AntigravityToolMetadata[];
  readonly record: AntigravityToolMetadata;
}): {
  readonly pendingToolCalls: readonly AntigravityToolMetadata[];
  readonly toolCall: AntigravityToolMetadata | undefined;
} => {
  const completedToolName = normalizedToolName(record);
  const pendingIndex = pendingToolCalls.findIndex(
    (toolCall) => normalizedToolName(toolCall) === completedToolName,
  );
  return Match.value(pendingIndex).pipe(
    Match.when(-1, () => ({ pendingToolCalls, toolCall: undefined })),
    Match.orElse((index) => ({
      pendingToolCalls: pendingToolCalls.filter(
        (_, pendingToolIndex) => pendingToolIndex !== index,
      ),
      toolCall: pendingToolCalls.at(index),
    })),
  );
};

/** Merges result-row metadata over pending planner metadata while preserving nested args. */
export const mergeToolMetadata = ({
  record,
  pendingToolCall,
}: {
  readonly record: AntigravityToolMetadata;
  readonly pendingToolCall: AntigravityToolMetadata | undefined;
}): AntigravityToolMetadata => ({
  ...pendingToolCall,
  ...record,
  args: {
    ...pendingToolCall?.args,
    ...record.args,
  },
});

/** Returns whether Antigravity result content indicates command failure. */
const commandResultFailed = (content: string | undefined): boolean =>
  Option.getOrElse(
    Option.fromUndefinedOr(content).pipe(
      Option.map((text) => /command failed|exit code|exited with/i.test(text)),
    ),
    () => false,
  );

/** Builds bounded command-result completion activity without relaying command output. */
const commandCompletionActivityText = (record: AntigravityTranscriptRecord): string =>
  Match.value(commandResultFailed(record.content)).pipe(
    Match.when(true, () => "Command failed"),
    Match.orElse(() => "Command completed"),
  );

/** Builds completed activity for a result row that has matching pending planner metadata. */
const completedPendingToolActivityText = ({
  record,
  metadata,
}: {
  readonly record: AntigravityTranscriptRecord;
  readonly metadata: AntigravityToolMetadata;
}): string | undefined =>
  Match.value(normalizedToolName(metadata)).pipe(
    Match.when("RUN_COMMAND", () => commandCompletionActivityText(record)),
    Match.orElse(() => undefined),
  );

/** Builds completed tool-result activity, suppressing duplicate path-based completions. */
export const completedToolActivityText = ({
  record,
  metadata,
  hasPendingToolCall,
}: {
  readonly record: AntigravityTranscriptRecord;
  readonly metadata: AntigravityToolMetadata;
  readonly hasPendingToolCall: boolean;
}): string | undefined =>
  Match.value(hasPendingToolCall).pipe(
    Match.when(true, () => completedPendingToolActivityText({ record, metadata })),
    Match.orElse(() => toolActivityText(metadata)),
  );
