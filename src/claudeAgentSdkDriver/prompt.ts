import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources";
import { Effect, Match, Option, Schema } from "effect";
import * as Path from "effect/Path";

import { AgentDriverError } from "../mockResponsesProvider/agentDriver.ts";
import type { ClaudeAgentSdkQueryPrompt } from "./claudeAgentSdkClient.ts";

/** Responses content or input item represented as a decoded JSON object. */
type ResponseRecord = Readonly<Record<string, unknown>>;

/** Options needed to map one Responses turn into Claude SDK user-message input. */
export interface ExtractClaudeAgentSdkPromptOptions {
  readonly input: unknown;
  readonly cwd: string;
}

/** Generic object schema used before current-turn-specific validation. */
const responseRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

/** Responses message item shape accepted by the Claude Agent SDK prompt extractor. */
const responseInputMessageSchema = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("user"),
  content: Schema.Array(responseRecordSchema),
});

/** Supported image MIME handlers for Anthropic base64 image blocks. */
const base64ImageBlockByMediaType: Readonly<Record<string, (data: string) => ImageBlockParam>> = {
  "image/gif": (data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/gif", data },
  }),
  "image/jpeg": (data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data },
  }),
  "image/png": (data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  }),
  "image/webp": (data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/webp", data },
  }),
};

/** Builds an explicit prompt extraction failure. */
const promptError = (message: string): AgentDriverError => new AgentDriverError({ message });

/** Reads a string property from a decoded Responses record. */
const stringProperty = ({
  name,
  record,
}: {
  readonly name: string;
  readonly record: ResponseRecord;
}): Option.Option<string> =>
  Option.fromUndefinedOr(record[name]).pipe(
    Option.filter((value): value is string => typeof value === "string"),
  );

/** Reads the first available string property from a decoded Responses record. */
const firstStringProperty = ({
  names,
  record,
}: {
  readonly names: readonly string[];
  readonly record: ResponseRecord;
}): Option.Option<string> =>
  Option.fromUndefinedOr(
    names
      .flatMap((name) =>
        Option.match(stringProperty({ name, record }), {
          onNone: () => [],
          onSome: (value) => [value],
        }),
      )
      .at(0),
  );

/** Converts one SDK user message into a one-shot async iterable prompt. */
const sdkUserMessagePrompt = (message: SDKUserMessage): ClaudeAgentSdkQueryPrompt => ({
  [Symbol.asyncIterator]: () => {
    let emitted = false;
    return {
      next: () => {
        const result = Option.match(
          Option.fromUndefinedOr([message].filter(() => !emitted).at(0)),
          {
            onNone: () => ({ done: true, value: undefined }) satisfies IteratorReturnResult<void>,
            onSome: (value) =>
              ({ done: false, value }) satisfies IteratorYieldResult<SDKUserMessage>,
          },
        );
        emitted = true;
        return Promise.resolve(result);
      },
    };
  },
});

/** Creates an Anthropic text block. */
const textBlock = (text: string): ContentBlockParam => ({ type: "text", text });

/** Parses one data URL into an Anthropic image block when the MIME type is supported. */
const imageBlockFromDataUrl = Effect.fnUntraced(function* (imageUrl: string) {
  const dataUrlParts = /^data:([^;,]+);base64,(.*)$/u.exec(imageUrl);
  const mediaType = Option.fromUndefinedOr(dataUrlParts?.at(1));
  const data = Option.fromUndefinedOr(dataUrlParts?.at(2));
  return yield* Option.match(mediaType, {
    onNone: () =>
      promptError("Claude Agent SDK input_image image_url must be a data URL or HTTP URL."),
    onSome: (nextMediaType) =>
      Option.match(data, {
        onNone: () =>
          promptError("Claude Agent SDK input_image data URL is missing base64 payload."),
        onSome: (nextData) =>
          Option.match(Option.fromUndefinedOr(base64ImageBlockByMediaType[nextMediaType]), {
            onNone: () =>
              promptError(
                `Claude Agent SDK input_image media type is unsupported: ${nextMediaType}.`,
              ),
            onSome: (buildImageBlock) => Effect.succeed(buildImageBlock(nextData)),
          }),
      }),
  });
});

/** Maps one Responses image URL to the SDK-supported image source variants. */
const imageBlockFromImageUrl = (imageUrl: string) =>
  Match.value(imageUrl.startsWith("http://") || imageUrl.startsWith("https://")).pipe(
    Match.when(true, () =>
      Effect.succeed({
        type: "image",
        source: { type: "url", url: imageUrl },
      } satisfies ImageBlockParam),
    ),
    Match.orElse(() => imageBlockFromDataUrl(imageUrl)),
  );

/** Returns true when a normalized relative path stays inside the workspace. */
const isSafeRelativeWorkspacePath = ({
  pathService,
  relativePath,
}: {
  readonly pathService: Path.Path;
  readonly relativePath: string;
}): boolean =>
  relativePath.length > 0 &&
  relativePath !== "." &&
  !relativePath.startsWith("..") &&
  !pathService.isAbsolute(relativePath);

/** Converts a user-supplied file reference into a safe workspace-relative path. */
const workspaceRelativePath = ({
  candidate,
  cwd,
  pathService,
}: {
  readonly candidate: string;
  readonly cwd: string;
  readonly pathService: Path.Path;
}) => {
  const normalizedCwd = pathService.normalize(cwd);
  const normalizedCandidate = pathService.normalize(candidate);
  const relativePath = Match.value(pathService.isAbsolute(normalizedCandidate)).pipe(
    Match.when(true, () => pathService.relative(normalizedCwd, normalizedCandidate)),
    Match.orElse(() => normalizedCandidate),
  );
  return Option.fromUndefinedOr(
    [relativePath].filter(() => isSafeRelativeWorkspacePath({ pathService, relativePath })).at(0),
  );
};

/** Maps one supported text content block into SDK prompt content. */
const sdkBlocksFromTextContent = Effect.fnUntraced(function* (content: ResponseRecord) {
  const text = yield* Option.match(stringProperty({ name: "text", record: content }), {
    onNone: () => promptError("Claude Agent SDK input_text content requires text."),
    onSome: Effect.succeed,
  });
  return [textBlock(text)];
});

/** Maps one supported image content block into SDK prompt content. */
const sdkBlocksFromImageContent = Effect.fnUntraced(function* (content: ResponseRecord) {
  yield* Option.match(stringProperty({ name: "file_id", record: content }), {
    onNone: () => Effect.void,
    onSome: () =>
      promptError(
        "Claude Agent SDK input_image file_id is unsupported without a fetch/decode path.",
      ),
  });
  const imageUrl = yield* Option.match(stringProperty({ name: "image_url", record: content }), {
    onNone: () => promptError("Claude Agent SDK input_image content requires image_url."),
    onSome: Effect.succeed,
  });
  const imageBlock = yield* imageBlockFromImageUrl(imageUrl);
  return [imageBlock];
});

/** Maps one supported file path reference into SDK prompt content. */
const sdkBlocksFromFileContent = Effect.fnUntraced(function* ({
  content,
  cwd,
  pathService,
}: {
  readonly content: ResponseRecord;
  readonly cwd: string;
  readonly pathService: Path.Path;
}) {
  yield* Option.match(stringProperty({ name: "file_id", record: content }), {
    onNone: () => Effect.void,
    onSome: () =>
      promptError(
        "Claude Agent SDK input_file file_id is unsupported without a fetch/decode path.",
      ),
  });
  const filePath = yield* Option.match(
    firstStringProperty({ names: ["file_path", "path"], record: content }),
    {
      onNone: () => promptError("Claude Agent SDK input_file content requires file_path or path."),
      onSome: Effect.succeed,
    },
  );
  const relativePath = yield* Option.match(
    workspaceRelativePath({ candidate: filePath, cwd, pathService }),
    {
      onNone: () =>
        promptError(`Claude Agent SDK input_file path is outside the workspace: ${filePath}.`),
      onSome: Effect.succeed,
    },
  );
  return [textBlock(`Workspace file: ${relativePath}`)];
});

/** Maps one current-turn Responses content item into zero or more SDK content blocks. */
const sdkBlocksFromContent = Effect.fnUntraced(function* ({
  content,
  cwd,
  pathService,
}: {
  readonly content: ResponseRecord;
  readonly cwd: string;
  readonly pathService: Path.Path;
}) {
  const contentType = yield* Option.match(stringProperty({ name: "type", record: content }), {
    onNone: () => promptError("Claude Agent SDK current-turn content requires type."),
    onSome: Effect.succeed,
  });
  return yield* Match.value(contentType).pipe(
    Match.when("input_text", () => sdkBlocksFromTextContent(content)),
    Match.when("input_image", () => sdkBlocksFromImageContent(content)),
    Match.when("input_file", () => sdkBlocksFromFileContent({ content, cwd, pathService })),
    Match.orElse(() =>
      promptError(`Unsupported Claude Agent SDK current-turn content: ${contentType}.`),
    ),
  );
});

/** Returns the single normalized user message expected at the driver boundary. */
const singleCurrentUserMessage = Effect.fnUntraced(function* (
  messages: readonly (typeof responseInputMessageSchema.Type)[],
) {
  const message = yield* Option.match(Option.fromUndefinedOr(messages.at(0)), {
    onNone: () => promptError("Claude Agent SDK driver requires a current user message."),
    onSome: Effect.succeed,
  });
  yield* Match.value(messages.length).pipe(
    Match.when(1, () => Effect.void),
    Match.orElse(() =>
      Effect.fail(
        promptError(
          "Claude Agent SDK driver requires exactly one normalized current user message.",
        ),
      ),
    ),
  );
  return message;
});

/** Extracts normalized current user input as a Claude Agent SDK user-message prompt. */
export const extractClaudeAgentSdkPrompt = Effect.fnUntraced(function* ({
  cwd,
  input,
}: ExtractClaudeAgentSdkPromptOptions) {
  const pathService = yield* Path.Path;
  const messages = yield* Schema.decodeUnknownEffect(Schema.Array(responseInputMessageSchema))(
    input,
  ).pipe(
    Effect.mapError(() =>
      promptError("Claude Agent SDK driver requires normalized current-turn user input."),
    ),
  );
  const message = yield* singleCurrentUserMessage(messages);
  const contentBlocks = yield* Effect.forEach(message.content, (content) =>
    sdkBlocksFromContent({ content, cwd, pathService }),
  ).pipe(Effect.map((blocks) => blocks.flat()));
  const nonEmptyContentBlocks = yield* Option.match(
    Option.fromUndefinedOr([contentBlocks].filter((blocks) => blocks.length > 0).at(0)),
    {
      onNone: () =>
        promptError(
          "Claude Agent SDK driver requires at least one supported current-turn content block.",
        ),
      onSome: Effect.succeed,
    },
  );

  return sdkUserMessagePrompt({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: nonEmptyContentBlocks,
    },
  });
});
