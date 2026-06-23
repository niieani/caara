import {
  query as createClaudeAgentSdkQuery,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Context, Effect, Layer, Match, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";

/** Prompt input accepted by the Claude Agent SDK query function. */
export type ClaudeAgentSdkQueryPrompt = string | AsyncIterable<SDKUserMessage>;

/** Runtime subset Caara needs from an SDK query while keeping tests structurally fakeable. */
export interface ClaudeAgentSdkQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly close: () => void;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (
    maxThinkingTokens: number | null,
    thinkingDisplay?: "summarized" | "omitted" | null,
  ) => Promise<void>;
}

/** SDK query creation request carried through the injectable client seam. */
export interface ClaudeAgentSdkQueryRequest {
  readonly prompt: ClaudeAgentSdkQueryPrompt;
  readonly options: ClaudeQueryOptions;
}

/** Failure raised when the SDK query constructor rejects synchronously. */
export class ClaudeAgentSdkClientError extends Schema.TaggedErrorClass<ClaudeAgentSdkClientError>()(
  "ClaudeAgentSdkClientError",
  {
    message: Schema.String,
  },
) {}

/** Effect contract for constructing one Claude Agent SDK query runtime. */
export type ClaudeAgentSdkCreateQuery = (
  request: ClaudeAgentSdkQueryRequest,
) => EffectContract<ClaudeAgentSdkQueryRuntime, ClaudeAgentSdkClientError>;

/** Injectable client service that owns the direct Claude Agent SDK dependency. */
export class ClaudeAgentSdkClient extends Context.Service<
  ClaudeAgentSdkClient,
  {
    readonly query: ClaudeAgentSdkCreateQuery;
  }
>()("@caara/ClaudeAgentSdkClient") {}

/** Formats an unknown SDK constructor failure into a typed client error. */
const clientError = (cause: unknown): ClaudeAgentSdkClientError =>
  new ClaudeAgentSdkClientError({
    message: clientErrorMessage(cause),
  });

/** Extracts a useful message from an unknown SDK constructor failure. */
const clientErrorMessage = (cause: unknown): string =>
  Match.value(cause).pipe(
    Match.when(
      (candidate: unknown): candidate is Error => candidate instanceof Error,
      (error) => error.message,
    ),
    Match.orElse(String),
  );

/** Live SDK client layer backed by the official Claude Agent SDK query function. */
export const claudeAgentSdkClientLive = Layer.succeed(ClaudeAgentSdkClient, {
  query: ({ prompt, options }) =>
    Effect.try({
      try: () => createClaudeAgentSdkQuery({ prompt, options }),
      catch: clientError,
    }),
});
