import { Match, Option } from "effect";

/** Default maximum visible characters for a shell command embedded in activity commentary. */
export const defaultShellCommandPreviewLength = 180;

/** Options for formatting a raw shell command into Markdown command preview text. */
export interface ShellCommandActivityPreviewOptions {
  readonly command: string;
  readonly maxLength?: number;
}

/** Options for formatting full command activity commentary text. */
export interface ShellCommandActivityTextOptions {
  readonly label: string;
  readonly command: string | undefined;
  readonly fallback: string;
  readonly maxLength?: number;
}

/** Clips a command preview to the maximum visible activity length. */
const clippedShellCommandPreview = ({
  command,
  maxLength,
}: {
  readonly command: string;
  readonly maxLength: number;
}): string =>
  Match.value(command).pipe(
    Match.when(
      (candidate) => candidate.length <= maxLength,
      (candidate) => candidate,
    ),
    Match.orElse((candidate) => `${candidate.slice(0, maxLength - 3)}...`),
  );

/** Returns a Markdown backtick delimiter that cannot be closed by the command text. */
const markdownBacktickDelimiter = ({ text }: { readonly text: string }): string => {
  const longestBacktickRun = text
    .match(/`+/gu)
    ?.reduce((longestRun, run) => Math.max(longestRun, run.length), 0);
  return "`".repeat((longestBacktickRun ?? 0) + 1);
};

/** Formats one string as Markdown inline code with a safe backtick delimiter. */
export const formatMarkdownInlineCode = ({ text }: { readonly text: string }): string => {
  const delimiter = markdownBacktickDelimiter({ text });
  return Match.value(text).pipe(
    Match.when(
      (candidate) => candidate.startsWith("`") || candidate.endsWith("`"),
      (candidate) => `${delimiter} ${candidate} ${delimiter}`,
    ),
    Match.orElse((candidate) => `${delimiter}${candidate}${delimiter}`),
  );
};

/** Formats one command as a Markdown shell code block. */
const markdownShellCodeBlock = ({ text }: { readonly text: string }): string => {
  const delimiter = Match.value(markdownBacktickDelimiter({ text })).pipe(
    Match.when(
      (candidate) => candidate.length >= 3,
      (candidate) => candidate,
    ),
    Match.orElse(() => "```"),
  );
  return `${delimiter}bash\n${text}\n${delimiter}`;
};

/** Normalizes and formats a command string for activity commentary. */
export const formatShellCommandActivityPreview = ({
  command,
  maxLength = defaultShellCommandPreviewLength,
}: ShellCommandActivityPreviewOptions): string | undefined => {
  const normalized = command.trim().replace(/\r\n?/gu, "\n");
  return Match.value(normalized).pipe(
    Match.when(
      (candidate) => candidate.length === 0,
      () => undefined,
    ),
    Match.when(
      (candidate) => candidate.includes("\n"),
      (candidate) =>
        markdownShellCodeBlock({
          text: clippedShellCommandPreview({ command: candidate, maxLength }),
        }),
    ),
    Match.orElse((candidate) =>
      formatMarkdownInlineCode({
        text: clippedShellCommandPreview({
          command: candidate.replace(/\s+/gu, " "),
          maxLength,
        }),
      }),
    ),
  );
};

/** Builds activity commentary with inline code for one-line commands and code blocks for multiline commands. */
export const formatShellCommandActivityText = ({
  label,
  command,
  fallback,
  maxLength,
}: ShellCommandActivityTextOptions): string => {
  const preview = Option.getOrUndefined(
    Option.fromUndefinedOr(command).pipe(
      Option.flatMap((rawCommand) =>
        Option.fromUndefinedOr(
          formatShellCommandActivityPreview({ command: rawCommand, maxLength }),
        ),
      ),
    ),
  );
  return Option.match(Option.fromUndefinedOr(preview), {
    onNone: () => fallback,
    onSome: (commandPreview) =>
      Match.value(commandPreview.includes("\n")).pipe(
        Match.when(true, () => `${label}:\n${commandPreview}`),
        Match.orElse(() => `${label}: ${commandPreview}`),
      ),
  });
};
