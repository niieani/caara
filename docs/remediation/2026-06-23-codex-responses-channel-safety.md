# Codex Responses Channel Safety

Date: 2026-06-23

Scope: investigation only. No implementation changes in this pass.

## Finding

Codex accepts only a small Responses SSE subset as a useful display surface. For Caara's external
agent activity commentary, the safe Codex-facing path is assistant `message` items, usually with
`phase: "commentary"`. Caara should not stream external-agent tool activity as Responses
`function_call`, `custom_tool_call`, tool-output, custom item, annotation, or raw payload events.

Full Claude SDK tool, task, status, and progress payloads should remain in Caara runtime events and
relay logs. Codex-facing activity should be terse human-readable commentary such as
"Reading src/server.ts".

## Sources Read

Primary reference tree:

- `/Volumes/Projects/SoftwareReferences/codex/`

Relevant Codex files:

- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/codex-api/src/sse/responses.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/protocol/src/models.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/src/session/turn.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/src/session/mod.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/src/event_mapping.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/src/stream_events_utils.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/src/tools/router.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/src/context_manager/history.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/src/agent/control/spawn.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/app-server/src/request_processors/thread_lifecycle.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/app-server/src/bespoke_event_handling.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/tui/src/chatwidget/protocol.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/tui/src/chatwidget/replay.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/tui/src/chatwidget/streaming.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/tui/src/chatwidget/tests/status_and_layout.rs`
- `/Volumes/Projects/SoftwareReferences/codex/codex-rs/core/tests/suite/client.rs`
- `/Volumes/Projects/SoftwareReferences/codex/sdk/typescript/tests/responsesProxy.ts`

## Parser Surface

The live Responses SSE parser is
`/Volumes/Projects/SoftwareReferences/codex/codex-rs/codex-api/src/sse/responses.rs`.

Useful parsed event kinds:

- `response.created`
- `response.output_item.added`
- `response.output_item.done`
- `response.output_text.delta`
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta`
- `response.reasoning_text.delta`
- `response.completed`
- `response.failed`
- `response.incomplete`

Parsed but not suitable for Caara display-only activity:

- `response.custom_tool_call_input.delta`

Not parsed or not useful for display:

- `response.content_part.added`
- `response.function_call_arguments.delta`
- top-level `type: "error"` in the Rust SSE path
- unknown SSE kinds, which are trace-logged and ignored

`response.output_text.delta` and reasoning deltas require an active item from
`response.output_item.added`. Without an active item, Codex treats the stream as malformed in debug
builds or logs an error in release builds.

## Response Item Types

Codex has typed `ResponseItem` variants in
`/Volumes/Projects/SoftwareReferences/codex/codex-rs/protocol/src/models.rs`.

Safe display substrate:

- `message` with `role: "assistant"`
- `phase: "commentary"` for activity summaries
- `phase: "final_answer"` for the final subagent answer
- `reasoning` only for displayable reasoning summaries, not tool activity

Risky or unsuitable for Caara display-only activity:

- `function_call`: Codex may execute it as a real tool call.
- `custom_tool_call`: Codex may execute it as a real tool call.
- `tool_search_call`: Codex may execute it when marked client-executed.
- `function_call_output`, `custom_tool_call_output`, `tool_search_output`: unexpected from the
  stream display path and not useful as visible progress.
- `local_shell_call`: accepted by the model type but not a safe Caara display primitive.
- unknown/custom item types: become `Other`, and payload is discarded.
- `computer_call`: no matching variant found; it becomes `Other`.
- annotations: not modeled on Codex `message` or `ContentItem`; unknown fields are dropped.

Codex content item support is narrow: `input_text`, `input_image`, and `output_text`.

## Semantic Action Versus Display

Codex acts semantically on some item types:

- `function_call` routes through Codex tool execution.
- `custom_tool_call` routes through Codex tool execution.
- `tool_search_call` can route to client `tool_search`.
- `response.completed` terminates the turn; `end_turn: false` can force a follow-up loop.

Codex displays/stores some non-tool items:

- assistant `message`
- `reasoning`
- `web_search_call`
- `image_generation_call`

Tool-output items from the stream are treated as unexpected and do not become useful visible UI.

## Storage And History

Parsed assistant `message` items are visible and enter Codex conversation history. This means
activity commentary is not only display/log output; it can influence later managing-agent context.
Keep commentary terse and milestone-level.

`phase: "commentary"` keeps commentary out of the final-answer markdown record, but it is still a
transcript item. Full-history subagent forks appear to keep assistant messages only when
`phase == "final_answer"`, but ordinary conversation history still stores non-system messages.

Raw response item notifications are not a reliable display surface:

- app-server raw forwarding is gated by `experimental_raw_events`;
- TUI ignores `RawResponseItemCompleted`;
- unknown item payloads have often already been discarded by typed deserialization.

## Safe Caara Subset

For visible external-agent progress, use:

```json
{
  "type": "response.output_item.done",
  "item": {
    "type": "message",
    "role": "assistant",
    "id": "caara_activity_1",
    "phase": "commentary",
    "content": [
      {
        "type": "output_text",
        "text": "Reading src/server.ts"
      }
    ]
  }
}
```

Streaming form is also acceptable when needed:

1. `response.output_item.added` for an assistant `message` item with `phase: "commentary"`;
2. zero or more `response.output_text.delta` chunks;
3. matching `response.output_item.done` with the full final content.

For final subagent output, use an assistant `message` item with `phase: "final_answer"`, then
`response.completed`.

## Keep Relay-Log Only

Keep these out of display-only Responses output:

- raw Claude SDK `tool_use`, `tool_result`, task, progress, status, and permission payloads;
- full tool args, stdout/stderr, JSON payloads, timings, and intermediate artifacts;
- Responses `function_call`, `custom_tool_call`, `tool_search_call`;
- Responses tool-output item types;
- `computer_call`;
- custom item types;
- annotations;
- `response.content_part.added`;
- top-level `type: "error"`.

Use `response.failed` or `response.incomplete` only for true terminal Caara response failures, not
for external-agent step failures that the external agent handles internally.

## Smoke Tests Still Needed

- Current Codex App visual test with repeated `phase: "commentary"` messages followed by a
  `phase: "final_answer"` message.
- TUI visual test for the same sequence.
- Prompt-history test to quantify how much commentary affects the next turn's prompt context.
- Raw-events opt-in test to confirm app-server/TUI behavior when `experimental_raw_events` is on.
- Error-shape test for top-level `type: "error"` versus `response.failed`.
- Annotation test confirming annotations are dropped.
