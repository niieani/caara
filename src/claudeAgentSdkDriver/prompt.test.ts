import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Result, Stream } from "effect";
import * as Path from "effect/Path";

import type { ClaudeAgentSdkQueryPrompt } from "./claudeAgentSdkClient.ts";
import { extractClaudeAgentSdkPrompt } from "./prompt.ts";

/** Stable workspace root used by SDK prompt mapping tests. */
const projectRootPath = (): "/workspace/project" => "/workspace/project";

/** Collects a concrete SDK user-message async iterable. */
const collectPromptStream = (promptStream: AsyncIterable<SDKUserMessage>) =>
  Stream.fromAsyncIterable(promptStream, String).pipe(
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  );

/** Collects the SDK user-message stream produced for one prompt. */
const collectPromptMessages = Effect.fnUntraced(function* (prompt: ClaudeAgentSdkQueryPrompt) {
  return yield* Match.value(prompt).pipe(
    Match.when(
      (candidate): candidate is string => typeof candidate === "string",
      () => Effect.sync(() => assert.fail("expected SDKUserMessage prompt stream")),
    ),
    Match.orElse(collectPromptStream),
  );
});

/** Extracts and collects SDK prompt messages for one Responses input fixture. */
const promptMessagesFromInput = (input: unknown) =>
  Effect.gen(function* () {
    const prompt = yield* extractClaudeAgentSdkPrompt({
      cwd: projectRootPath(),
      input,
    });
    return yield* collectPromptMessages(prompt);
  }).pipe(Effect.provide(Path.layer));

/** Formats an unknown prompt mapping failure for assertions. */
const failureMessage = (error: unknown): string =>
  Match.value(error).pipe(
    Match.when(
      (candidate: unknown): candidate is { readonly message: string } =>
        typeof candidate === "object" && candidate !== null && "message" in candidate,
      (candidate) => candidate.message,
    ),
    Match.orElse(String),
  );

/** Extracts the driver error message from an expected prompt mapping failure. */
const promptErrorMessage = (result: Result.Result<unknown, unknown>): string =>
  Result.match(result, {
    onFailure: failureMessage,
    onSuccess: () => assert.fail("expected prompt mapping failure"),
  });

describe("Claude Agent SDK prompt mapping", () => {
  it.effect("maps current-turn text only and does not replay assistant or tool history", () =>
    Effect.gen(function* () {
      const messages = yield* promptMessagesFromInput([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first request" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "previous assistant answer" }],
        },
        {
          type: "function_call_output",
          call_id: "call_previous",
          output: "previous tool output",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "current request" }],
        },
      ]);

      assert.deepStrictEqual(messages, [
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "text", text: "current request" }],
          },
        } satisfies SDKUserMessage,
      ]);
    }),
  );

  it.effect("maps current-turn data-url images to SDK image blocks", () =>
    Effect.gen(function* () {
      const messages = yield* promptMessagesFromInput([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
          ],
        },
      ]);

      assert.deepStrictEqual(messages, [
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "aW1hZ2U=",
                },
              },
            ],
          },
        } satisfies SDKUserMessage,
      ]);
    }),
  );

  it.effect("maps workspace-addressable path references to explicit SDK text blocks", () =>
    Effect.gen(function* () {
      const messages = yield* promptMessagesFromInput([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "review this file" },
            { type: "input_file", file_path: "src/server.ts" },
          ],
        },
      ]);

      assert.deepStrictEqual(messages, [
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              { type: "text", text: "review this file" },
              { type: "text", text: "Workspace file: src/server.ts" },
            ],
          },
        } satisfies SDKUserMessage,
      ]);
    }),
  );

  it.effect("rejects opaque file ids and unknown current-turn content explicitly", () =>
    Effect.gen(function* () {
      const fileIdResult = yield* Effect.result(
        promptMessagesFromInput([
          {
            type: "message",
            role: "user",
            content: [{ type: "input_file", file_id: "file_opaque" }],
          },
        ]),
      );
      const unknownContentResult = yield* Effect.result(
        promptMessagesFromInput([
          {
            type: "message",
            role: "user",
            content: [{ type: "input_audio", audio_url: "data:audio/wav;base64,AA==" }],
          },
        ]),
      );

      assert.match(promptErrorMessage(fileIdResult), /file_id.*unsupported/i);
      assert.match(
        promptErrorMessage(unknownContentResult),
        /Unsupported Claude Agent SDK current-turn content: input_audio/,
      );
    }),
  );
});
