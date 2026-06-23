import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Match, Stream } from "effect";
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

describe("Claude Agent SDK prompt mapping", () => {
  it.effect("maps normalized current-turn text", () =>
    Effect.gen(function* () {
      const messages = yield* promptMessagesFromInput([
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

  it.effect("fails raw mixed Codex history instead of selecting the latest user locally", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        promptMessagesFromInput([
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "developer instructions" }],
          },
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
              },
              {
                type: "input_text",
                text: "<environment_context><cwd>/workspace</cwd></environment_context>",
              },
            ],
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
        ]),
      );

      assert.match(failureMessage(error), /normalized current-turn user input/i);
    }),
  );

  it.effect("fails multiple user messages instead of selecting a stale or latest request", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        promptMessagesFromInput([
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first request" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "current request" }],
          },
        ]),
      );

      assert.match(failureMessage(error), /exactly one normalized current user message/i);
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
      const fileIdError = yield* Effect.flip(
        promptMessagesFromInput([
          {
            type: "message",
            role: "user",
            content: [{ type: "input_file", file_id: "file_opaque" }],
          },
        ]),
      );
      const unknownContentError = yield* Effect.flip(
        promptMessagesFromInput([
          {
            type: "message",
            role: "user",
            content: [{ type: "input_audio", audio_url: "data:audio/wav;base64,AA==" }],
          },
        ]),
      );

      assert.match(failureMessage(fileIdError), /file_id.*unsupported/i);
      assert.match(
        failureMessage(unknownContentError),
        /Unsupported Claude Agent SDK current-turn content: input_audio/,
      );
    }),
  );
});
