import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { assert } from "@effect/vitest";

import type { ClaudeAgentSdkQueryRequest } from "./claudeAgentSdkClient.ts";

/** SDK option keys installed by Caara's noninteractive permission policy. */
type ClaudeQueryPermissionPolicyKey =
  | "canUseTool"
  | "disallowedTools"
  | "onUserDialog"
  | "permissionMode"
  | "supportedDialogKinds";

/** SDK query options after removing permission-policy callbacks and defaults. */
export type ClaudeQueryOptionsWithoutPermissionPolicy = Omit<
  ClaudeQueryOptions,
  ClaudeQueryPermissionPolicyKey
>;

/** SDK query request shape after removing permission-policy callbacks and defaults. */
export interface ClaudeQueryRequestWithoutPermissionPolicy {
  readonly prompt: ClaudeAgentSdkQueryRequest["prompt"];
  readonly options: ClaudeQueryOptionsWithoutPermissionPolicy;
}

/** Returns SDK options without Caara's always-on noninteractive permission policy fields. */
export const queryOptionsWithoutPermissionPolicy = ({
  canUseTool: _canUseTool,
  disallowedTools: _disallowedTools,
  onUserDialog: _onUserDialog,
  permissionMode: _permissionMode,
  supportedDialogKinds: _supportedDialogKinds,
  ...options
}: ClaudeQueryOptions): ClaudeQueryOptionsWithoutPermissionPolicy => options;

/** Returns SDK query requests without Caara's always-on noninteractive permission policy fields. */
export const queryRequestsWithoutPermissionPolicy = (
  requests: readonly ClaudeAgentSdkQueryRequest[],
): readonly ClaudeQueryRequestWithoutPermissionPolicy[] =>
  requests.map((request) => ({
    prompt: request.prompt,
    options: queryOptionsWithoutPermissionPolicy(request.options),
  }));

/** Asserts that SDK query options carry Caara's noninteractive permission policy. */
export const assertNonInteractivePermissionPolicy = (options: ClaudeQueryOptions): void => {
  assert.strictEqual(options.permissionMode, "dontAsk");
  assert.deepStrictEqual(options.disallowedTools, ["AskUserQuestion"]);
  assert.deepStrictEqual(options.supportedDialogKinds, []);
  assert.strictEqual(typeof options.canUseTool, "function");
  assert.strictEqual(typeof options.onUserDialog, "function");
};

/** Asserts that every recorded SDK query request carries Caara's permission policy. */
export const assertRequestsUseNonInteractivePermissionPolicy = (
  requests: readonly ClaudeAgentSdkQueryRequest[],
): void => requests.forEach((request) => assertNonInteractivePermissionPolicy(request.options));
