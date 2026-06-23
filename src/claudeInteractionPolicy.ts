import { Option } from "effect";

/** Returns the Claude tool reserved for interactive questions that Caara cannot answer during a turn. */
export const claudeAskUserQuestionToolName = (): "AskUserQuestion" => "AskUserQuestion";

/** Returns the permission mode that denies unapproved tool use instead of prompting interactively. */
export const claudeNonInteractivePermissionMode = (): "dontAsk" => "dontAsk";

/** Returns the deterministic denial message used when a permission prompt reaches Caara. */
export const claudeNonInteractivePermissionDeniedMessage = (): string =>
  "Caara subagents cannot approve interactive tool permissions during a Codex turn.";

/** Splits comma-delimited Claude tool query parameters while dropping empty entries. */
export const parseClaudeToolList = (tools: string): string[] =>
  tools
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);

/** Returns true when a tool list includes Caara's reserved interactive question tool. */
export const includesReservedInteractiveTool = (tools: readonly string[]): boolean =>
  tools.some((tool) => tool === claudeAskUserQuestionToolName());

/** Adds the reserved interactive question tool to a disallow list once. */
export const withReservedInteractiveToolDisallowed = (
  tools: readonly string[] | undefined,
): string[] => [
  ...new Set([
    ...Option.getOrElse(Option.fromUndefinedOr(tools), () => [] as readonly string[]),
    claudeAskUserQuestionToolName(),
  ]),
];
