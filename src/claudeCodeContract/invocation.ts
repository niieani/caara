import {
  claudeNonInteractivePermissionMode,
  withReservedInteractiveToolDisallowed,
} from "../claudeInteractionPolicy.ts";

/** Supported Claude Code effort literals shown by the installed CLI help. */
export const claudeCodeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;

/** Claude Code effort option accepted by `claude --effort`. */
export type ClaudeCodeEffort = (typeof claudeCodeEfforts)[number];

/** Claude Code permission mode accepted by `claude --permission-mode`. */
export type ClaudeCodePermissionMode = "dontAsk";

/** Tool selection contract for `claude --tools` in print-mode probes. */
export type ClaudeCodeToolSelection = "disabled" | "default" | readonly string[];

/** Input needed to construct one Claude Code print-mode contract invocation. */
export interface ClaudeCodePrintInvocationOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly effort?: ClaudeCodeEffort;
  readonly maxBudgetUsd?: string;
  readonly tools?: ClaudeCodeToolSelection;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly permissionMode?: ClaudeCodePermissionMode;
  readonly debugFile?: string;
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
  readonly includePartialMessages?: boolean;
}

/** Spawn-ready Claude Code command line with its cwd kept separate from argv. */
export interface ClaudeCodePrintInvocation {
  readonly command: "claude";
  readonly cwd: string;
  readonly args: readonly string[];
}

/** Converts a Claude Code tool-selection value into the CLI argument value. */
const formatToolSelection = (tools: ClaudeCodeToolSelection): string => {
  if (tools === "disabled") {
    return "";
  }
  if (tools === "default") {
    return "default";
  }
  return tools.join(",");
};

/** Converts a Claude Code allow/deny tool list into one CLI argument value. */
const formatToolList = (tools: readonly string[]): string => tools.join(",");

/** Builds the spawn-ready argv for Claude Code print-mode stream-json probes. */
export const buildClaudeCodePrintInvocation = ({
  cwd,
  prompt,
  model,
  effort,
  maxBudgetUsd,
  tools,
  allowedTools,
  disallowedTools,
  permissionMode = claudeNonInteractivePermissionMode(),
  debugFile,
  sessionId,
  resumeSessionId,
  includePartialMessages,
}: ClaudeCodePrintInvocationOptions): ClaudeCodePrintInvocation => {
  const args = ["-p", "--verbose", "--output-format", "stream-json"];

  if (includePartialMessages === true) {
    args.push("--include-partial-messages");
  }
  if (sessionId !== undefined) {
    args.push("--session-id", sessionId);
  }
  if (resumeSessionId !== undefined) {
    args.push("--resume", resumeSessionId);
  }

  args.push("--model", model);

  if (effort !== undefined) {
    args.push("--effort", effort);
  }
  if (maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", maxBudgetUsd);
  }
  if (tools !== undefined) {
    args.push("--tools", formatToolSelection(tools));
  }
  if (allowedTools !== undefined) {
    args.push("--allowed-tools", formatToolList(allowedTools));
  }
  args.push(
    "--permission-mode",
    permissionMode,
    "--disallowed-tools",
    formatToolList(withReservedInteractiveToolDisallowed(disallowedTools)),
  );
  if (debugFile !== undefined) {
    args.push("--debug-file", debugFile);
  }

  args.push(prompt);

  return {
    command: "claude",
    cwd,
    args,
  };
};
