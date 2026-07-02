import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Match, Schema } from "effect";

import { stringField } from "./unknownObservationTelemetry.ts";

/** SDK permission-denied message emitted after noninteractive permission rejection. */
export type ClaudeAgentSdkPermissionDeniedMessage = Extract<
  SDKMessage,
  { readonly type: "system"; readonly subtype: "permission_denied" }
>;

/** Safe subset of SDK assistant text content used for final fallback rendering. */
const sdkAssistantTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

/** Safe subset of SDK assistant text content used for final fallback rendering. */
type SdkAssistantTextContent = typeof sdkAssistantTextContentSchema.Type;

/** Safe subset of SDK assistant thinking content used for reasoning rendering. */
const sdkAssistantThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
});

/** Safe subset of SDK assistant thinking content used for reasoning rendering. */
type SdkAssistantThinkingContent = typeof sdkAssistantThinkingContentSchema.Type;

/** Safe subset of SDK assistant tool-use content used for activity rendering. */
const sdkAssistantToolUseContentSchema = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});

/** Safe subset of SDK assistant tool-use content used for activity rendering. */
export type SdkAssistantToolUseContent = typeof sdkAssistantToolUseContentSchema.Type;

/** Safe subset of SDK result-error messages used for driver failures. */
const sdkResultErrorMessageSchema = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  errors: Schema.Array(Schema.String),
});

/** Safe subset of SDK result-error messages used for driver failures. */
type SdkResultErrorMessage = typeof sdkResultErrorMessageSchema.Type;

/** Classified SDK message route used after validating the minimum shape Caara understands. */
export type SdkMessageRoute =
  | {
      readonly _tag: "StreamEvent";
      readonly message: Extract<SDKMessage, { readonly type: "stream_event" }>;
    }
  | {
      readonly _tag: "Assistant";
      readonly message: Extract<SDKMessage, { readonly type: "assistant" }>;
    }
  | {
      readonly _tag: "User";
      readonly message: Extract<SDKMessage, { readonly type: "user" }>;
    }
  | {
      readonly _tag: "TaskStarted";
      readonly message: Extract<
        SDKMessage,
        { readonly type: "system"; readonly subtype: "task_started" }
      >;
    }
  | {
      readonly _tag: "TaskProgress";
      readonly message: Extract<
        SDKMessage,
        { readonly type: "system"; readonly subtype: "task_progress" }
      >;
    }
  | {
      readonly _tag: "ResultSuccess";
    }
  | {
      readonly _tag: "ResultError";
      readonly message: SdkResultErrorMessage;
    }
  | {
      readonly _tag: "PermissionDenied";
      readonly message: ClaudeAgentSdkPermissionDeniedMessage;
    }
  | {
      readonly _tag: "Ignored";
      readonly message: unknown;
    };

/** Returns true when assistant content carries completed displayable text. */
export const isSdkAssistantTextContent = (value: unknown): value is SdkAssistantTextContent =>
  Schema.is(sdkAssistantTextContentSchema)(value);

/** Returns true when assistant content carries completed displayable reasoning. */
export const isSdkAssistantThinkingContent = (
  value: unknown,
): value is SdkAssistantThinkingContent => Schema.is(sdkAssistantThinkingContentSchema)(value);

/** Returns true when assistant content carries a tool invocation. */
export const isSdkAssistantToolUseContent = (value: unknown): value is SdkAssistantToolUseContent =>
  Schema.is(sdkAssistantToolUseContentSchema)(value);

/** Returns true when one SDK message has a specific top-level type. */
const sdkMessageHasType = ({
  message,
  type,
}: {
  readonly message: unknown;
  readonly type: string;
}): boolean => stringField(message, "type") === type;

/** Returns true when one SDK message has a specific top-level type and subtype. */
const sdkMessageHasTypeAndSubtype = ({
  message,
  type,
  subtype,
}: {
  readonly message: unknown;
  readonly type: string;
  readonly subtype: string;
}): boolean => sdkMessageHasType({ message, type }) && stringField(message, "subtype") === subtype;

/** Returns true when one SDK message is a raw stream event wrapper. */
const isSdkStreamEventMessage = (
  message: unknown,
): message is Extract<SDKMessage, { readonly type: "stream_event" }> =>
  sdkMessageHasType({ message, type: "stream_event" });

/** Returns true when one SDK message is a completed assistant message. */
const isSdkAssistantMessage = (
  message: unknown,
): message is Extract<SDKMessage, { readonly type: "assistant" }> =>
  sdkMessageHasType({ message, type: "assistant" });

/** Returns true when one SDK message is a user message. */
const isSdkUserMessage = (
  message: unknown,
): message is Extract<SDKMessage, { readonly type: "user" }> =>
  sdkMessageHasType({ message, type: "user" });

/** Returns true when one SDK message starts a task. */
const isSdkTaskStartedMessage = (
  message: unknown,
): message is Extract<SDKMessage, { readonly type: "system"; readonly subtype: "task_started" }> =>
  sdkMessageHasTypeAndSubtype({ message, type: "system", subtype: "task_started" });

/** Returns true when one SDK message reports task progress. */
const isSdkTaskProgressMessage = (
  message: unknown,
): message is Extract<SDKMessage, { readonly type: "system"; readonly subtype: "task_progress" }> =>
  sdkMessageHasTypeAndSubtype({ message, type: "system", subtype: "task_progress" });

/** Returns true when one SDK message is a successful terminal result. */
const isSdkResultSuccessMessage = (
  message: unknown,
): message is Extract<SDKMessage, { readonly type: "result"; readonly subtype: "success" }> =>
  sdkMessageHasTypeAndSubtype({ message, type: "result", subtype: "success" });

/** Returns true when one SDK message is an error terminal result. */
const isSdkResultErrorMessage = (message: unknown): message is SdkResultErrorMessage =>
  Schema.is(sdkResultErrorMessageSchema)(message);

/** Returns true when one SDK message reports a permission denial. */
const isSdkPermissionDeniedMessage = (
  message: unknown,
): message is ClaudeAgentSdkPermissionDeniedMessage =>
  sdkMessageHasTypeAndSubtype({ message, type: "system", subtype: "permission_denied" });

/** Classifies one unknown SDK message into the route Caara can safely process. */
export const sdkMessageRoute = (message: unknown): SdkMessageRoute =>
  Match.value(message).pipe(
    Match.when(
      isSdkStreamEventMessage,
      (sdkMessage): SdkMessageRoute => ({ _tag: "StreamEvent", message: sdkMessage }),
    ),
    Match.when(
      isSdkAssistantMessage,
      (sdkMessage): SdkMessageRoute => ({ _tag: "Assistant", message: sdkMessage }),
    ),
    Match.when(
      isSdkUserMessage,
      (sdkMessage): SdkMessageRoute => ({ _tag: "User", message: sdkMessage }),
    ),
    Match.when(
      isSdkTaskStartedMessage,
      (sdkMessage): SdkMessageRoute => ({ _tag: "TaskStarted", message: sdkMessage }),
    ),
    Match.when(
      isSdkTaskProgressMessage,
      (sdkMessage): SdkMessageRoute => ({ _tag: "TaskProgress", message: sdkMessage }),
    ),
    Match.when(isSdkResultSuccessMessage, (): SdkMessageRoute => ({ _tag: "ResultSuccess" })),
    Match.when(
      isSdkResultErrorMessage,
      (sdkMessage): SdkMessageRoute => ({ _tag: "ResultError", message: sdkMessage }),
    ),
    Match.when(
      isSdkPermissionDeniedMessage,
      (sdkMessage): SdkMessageRoute => ({ _tag: "PermissionDenied", message: sdkMessage }),
    ),
    Match.orElse((sdkMessage): SdkMessageRoute => ({ _tag: "Ignored", message: sdkMessage })),
  );

/** Builds the driver-facing failure text from one SDK result-error message. */
export const sdkResultErrorMessage = (message: SdkResultErrorMessage): string =>
  message.errors.at(0) ?? `Claude Agent SDK failed with subtype ${message.subtype}.`;
