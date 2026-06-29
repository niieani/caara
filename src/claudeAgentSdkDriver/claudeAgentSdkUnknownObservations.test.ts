import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestConsole } from "effect/testing";

import type { AgentDriverTurn, AgentRuntimeEvent } from "../mockResponsesProvider/agentDriver.ts";
import { AgentTarget, CodexTurnContext } from "../mockResponsesProvider/codexTurnContext.ts";
import {
  fakeSdkHarness,
  runDriverTurn,
  sdkAssistantTextMessage,
  sdkContentBlockStop,
  sdkMessageDelta,
  sdkTextDelta,
} from "./claudeAgentSdkDriverTestHarness.ts";

/** Stable cwd used by unknown-observation regression tests. */
const projectRoot = process.cwd();

/** Stable SDK session id used by unknown-observation regression tests. */
const sdkSessionId = (): string => "00000000-0000-4000-8000-00000000b101";

/** Unsafe SDK payload fragments that must not reach visible output or logs. */
const unsafeUnknownObservationFragments = [
  "RAW_UNKNOWN_SDK_MESSAGE_SHOULD_NOT_LEAK",
  "RAW_UNKNOWN_ASSISTANT_BLOCK_SHOULD_NOT_LEAK",
  "RAW_UNKNOWN_STREAM_BLOCK_SHOULD_NOT_LEAK",
  "RAW_UNKNOWN_STREAM_DELTA_SHOULD_NOT_LEAK",
  "RAW_TEXT_DELTA_AFTER_UNKNOWN_BLOCK_SHOULD_NOT_LEAK",
] as const;

/** Builds Codex identity context for one direct unknown-observation driver test turn. */
const makeCodex = (): CodexTurnContext =>
  new CodexTurnContext({
    parentSessionId: "parent-session-sdk-unknown",
    threadId: "codex-thread-sdk-unknown",
    turnId: "turn-sdk-unknown",
    parentThreadId: "parent-thread-sdk-unknown",
    windowId: "window-sdk-unknown",
    requestKind: "turn",
    subagentKind: "caara",
    originator: "codex_cli_rs",
    requestedModel: "claude/sonnet",
    sandboxPosture: "enforced",
    workspacePaths: [projectRoot],
    cwdCandidates: [projectRoot],
  });

/** Builds one selected Claude target for unknown-observation driver tests. */
const makeTarget = (): AgentTarget =>
  new AgentTarget({
    requestedModel: "claude/sonnet",
    externalAgentKind: "claude",
    externalModelSpecifier: "sonnet",
    rawDriverOptions: {},
  });

/** Builds one direct driver turn with core-normalized current-user prompt input. */
const makeTurn = (): AgentDriverTurn => ({
  codex: makeCodex(),
  target: makeTarget(),
  prompt: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "handle SDK drift" }],
      },
    ],
  },
  cwd: projectRoot,
  requestedCwd: projectRoot,
  previousTarget: undefined,
  externalSession: undefined,
});

/** Builds a future SDK message type outside the installed closed union. */
const sdkUnknownMessage = (): SDKMessage => {
  return {
    // @ts-expect-error Future SDK drift fixture intentionally falls outside current SDKMessage.
    type: "future_observation",
    payload: "RAW_UNKNOWN_SDK_MESSAGE_SHOULD_NOT_LEAK",
    uuid: "00000000-0000-4000-8000-00000000b201",
    session_id: sdkSessionId(),
  };
};

/** Builds an assistant message that contains one future content block plus final text. */
const sdkAssistantWithUnknownContent = (): SDKMessage => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    id: "msg_sdk_unknown_content",
    type: "message",
    container: null,
    context_management: null,
    diagnostics: null,
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [
      {
        // @ts-expect-error Future assistant content block intentionally falls outside current union.
        type: "future_content_block",
        payload: "RAW_UNKNOWN_ASSISTANT_BLOCK_SHOULD_NOT_LEAK",
      },
      {
        type: "text",
        text: "Final answer with ignored content.",
        citations: null,
      },
    ],
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 0,
      iterations: [],
      output_tokens: 0,
      output_tokens_details: {
        thinking_tokens: 0,
      },
      server_tool_use: {
        web_fetch_requests: 0,
        web_search_requests: 0,
      },
      service_tier: "standard",
      speed: "standard",
    },
  },
  uuid: "00000000-0000-4000-8000-00000000b202",
  session_id: sdkSessionId(),
});

/** Builds a stream event whose content block is outside the installed SDK union. */
const sdkUnknownStreamBlock = ({ index = 0 }: { readonly index?: number } = {}): SDKMessage => ({
  type: "stream_event",
  event: {
    type: "content_block_start",
    index,
    content_block: {
      // @ts-expect-error Future stream content block intentionally falls outside current union.
      type: "future_stream_block",
      payload: "RAW_UNKNOWN_STREAM_BLOCK_SHOULD_NOT_LEAK",
    },
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-00000000b203",
  session_id: sdkSessionId(),
});

/** Builds a stream event whose delta is outside the installed SDK union. */
const sdkUnknownStreamDelta = ({ index = 0 }: { readonly index?: number } = {}): SDKMessage => ({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index,
    delta: {
      // @ts-expect-error Future stream delta intentionally falls outside current union.
      type: "future_stream_delta",
      payload: "RAW_UNKNOWN_STREAM_DELTA_SHOULD_NOT_LEAK",
    },
  },
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-00000000b204",
  session_id: sdkSessionId(),
});

/** Extracts visible text deltas from direct driver runtime events. */
const contentDeltaTexts = (events: readonly AgentRuntimeEvent[]): readonly string[] =>
  events.filter((event) => event._tag === "ContentDelta").map((event) => event.text);

/** Encodes runtime events for raw-payload leakage assertions. */
const encodedRuntimeEvents = (events: readonly AgentRuntimeEvent[]): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)(events);

describe("Claude Agent SDK unknown observations", () => {
  it.effect("ignores unknown SDK message types with payload-safe telemetry", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [sdkSessionId()],
        runtimeMessages: [
          [
            sdkUnknownMessage(),
            sdkAssistantTextMessage({
              sessionId: sdkSessionId(),
              text: "Final answer after unknown message.",
            }),
          ],
        ],
      });

      const { events } = yield* runDriverTurn({ harness, turn: makeTurn() });
      const eventText = encodedRuntimeEvents(events);
      const logText = (yield* TestConsole.logLines).join("\n");

      assert.deepStrictEqual(contentDeltaTexts(events), ["Final answer after unknown message."]);
      assert.ok(logText.includes('"event":"caara.claude_sdk.ignored_observation"'));
      assert.ok(logText.includes('"provider":"claude"'));
      assert.ok(logText.includes('"shape":"message/future_observation"'));
      assert.match(logText, /"payloadSha256":"[a-f0-9]{64}"/u);
      for (const unsafeFragment of unsafeUnknownObservationFragments) {
        assert.ok(!eventText.includes(unsafeFragment), unsafeFragment);
        assert.ok(!logText.includes(unsafeFragment), unsafeFragment);
      }
    }),
  );

  it.effect("ignores unknown assistant content blocks with payload-safe telemetry", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [sdkSessionId()],
        runtimeMessages: [[sdkAssistantWithUnknownContent()]],
      });

      const { events } = yield* runDriverTurn({ harness, turn: makeTurn() });
      const eventText = encodedRuntimeEvents(events);
      const logText = (yield* TestConsole.logLines).join("\n");

      assert.deepStrictEqual(contentDeltaTexts(events), ["Final answer with ignored content."]);
      assert.ok(logText.includes('"shape":"assistant/content/future_content_block"'));
      assert.match(logText, /"payloadSha256":"[a-f0-9]{64}"/u);
      for (const unsafeFragment of unsafeUnknownObservationFragments) {
        assert.ok(!eventText.includes(unsafeFragment), unsafeFragment);
        assert.ok(!logText.includes(unsafeFragment), unsafeFragment);
      }
    }),
  );

  it.effect("ignores unknown stream block and delta shapes with payload-safe telemetry", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [sdkSessionId()],
        runtimeMessages: [
          [
            sdkUnknownStreamBlock(),
            sdkUnknownStreamDelta({ index: 1 }),
            sdkAssistantTextMessage({
              sessionId: sdkSessionId(),
              text: "Final answer after unknown stream observations.",
            }),
          ],
        ],
      });

      const { events } = yield* runDriverTurn({ harness, turn: makeTurn() });
      const eventText = encodedRuntimeEvents(events);
      const logText = (yield* TestConsole.logLines).join("\n");

      assert.deepStrictEqual(contentDeltaTexts(events), [
        "Final answer after unknown stream observations.",
      ]);
      assert.ok(logText.includes('"shape":"stream_event/content_block_start/future_stream_block"'));
      assert.ok(logText.includes('"shape":"stream_event/content_block_delta/future_stream_delta"'));
      assert.match(logText, /"payloadSha256":"[a-f0-9]{64}"/u);
      for (const unsafeFragment of unsafeUnknownObservationFragments) {
        assert.ok(!eventText.includes(unsafeFragment), unsafeFragment);
        assert.ok(!logText.includes(unsafeFragment), unsafeFragment);
      }
    }),
  );

  it.effect("does not orphan text deltas from an ignored stream block", () =>
    Effect.gen(function* () {
      const harness = fakeSdkHarness({
        sessionIds: [sdkSessionId()],
        runtimeMessages: [
          [
            sdkUnknownStreamBlock(),
            sdkTextDelta({
              sessionId: sdkSessionId(),
              text: "RAW_TEXT_DELTA_AFTER_UNKNOWN_BLOCK_SHOULD_NOT_LEAK",
            }),
            sdkContentBlockStop({ sessionId: sdkSessionId() }),
            sdkMessageDelta({ sessionId: sdkSessionId(), stopReason: "end_turn" }),
            sdkAssistantTextMessage({
              sessionId: sdkSessionId(),
              text: "Final answer after ignored stream block text.",
            }),
          ],
        ],
      });

      const { events } = yield* runDriverTurn({ harness, turn: makeTurn() });
      const eventText = encodedRuntimeEvents(events);
      const logText = (yield* TestConsole.logLines).join("\n");

      assert.deepStrictEqual(contentDeltaTexts(events), [
        "Final answer after ignored stream block text.",
      ]);
      assert.ok(logText.includes('"shape":"stream_event/content_block_start/future_stream_block"'));
      assert.ok(
        logText.includes('"shape":"stream_event/content_block_delta/ignored_block/text_delta"'),
      );
      for (const unsafeFragment of unsafeUnknownObservationFragments) {
        assert.ok(!eventText.includes(unsafeFragment), unsafeFragment);
        assert.ok(!logText.includes(unsafeFragment), unsafeFragment);
      }
    }),
  );
});
