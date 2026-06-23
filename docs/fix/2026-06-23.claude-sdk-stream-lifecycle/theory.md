# Claude SDK stream lifecycle

## Problem thesis

Claude Agent SDK partial assistant output is a stream of raw Anthropic content-block events. Caara
currently treats each `text_delta` or `thinking_delta` as a complete runtime item. That violates the
Responses stream contract Caara already models elsewhere: an output item starts once, receives zero
or more text deltas, then completes once.

The visible symptom is fragmented Claude text rendered as many tiny blocks. Depending on Codex UI
surface, those fragments can look like "thinking" even when the SDK event is ordinary assistant
`text_delta`.

## Operating theory

The correct boundary is the SDK content block, not the SDK delta. `content_block_start` selects the
runtime item kind, `content_block_delta` appends content to that item, and `content_block_stop`
completes it. Text blocks become assistant messages with `phase: "final_answer"`. Thinking blocks
become displayable reasoning summary items. Tool and task activity remains separately mapped to
terse commentary messages.

Completed SDK assistant messages are still useful as a fallback for SDK paths that do not emit
partial stream events, but they must not duplicate already-streamed content blocks. This fix should
make the partial-message path stateful and leave the fallback path intact.

The implemented mapper now tracks active raw content blocks by SDK block index. This preserves
delta-only fallback behavior for older/fake SDK streams, while real raw stream lifecycles produce
one Caara runtime item per content block. It also tracks which final assistant content indexes were
already streamed so the final SDK assistant message does not duplicate public text or displayable
thinking.

## Strategy

Start with direct driver regression tests because they assert CAARA's normalized runtime events
before HTTP/SSE encoding. Then keep the existing provider activity tests as boundary coverage:
after the driver emits one item lifecycle per SDK block, the runtime encoder already knows how to
produce one `response.output_item.added`, multiple `response.output_text.delta` or
`response.reasoning_summary_text.delta` frames, and one `response.output_item.done`.

Verification covers direct runtime events, provider-boundary SSE output, the full Claude SDK driver
test directory, typecheck, changed-file formatting, full lint, and the current default Vitest run.
Those checks are green. The Biome schema now matches the installed 2.5.1 CLI, and stale Vitest
project split scripts were removed because the repository currently has one configured project:
`default`.

The same long-thinking scenario that exposed fragmented deltas can also keep the SSE stream quiet
long enough for Bun's default 10-second idle timer to close the connection. The live Caara server now
sets Bun's `idleTimeout` to `0`, which the installed Bun docs define as disabling the timeout.

## References

- `src/claudeAgentSdkDriver/events.ts`: owns SDK stream event to Caara runtime event mapping.
- `src/mockResponsesProvider/runtimeResponseEncoder.ts`: already supports multi-delta item state.
- `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts`: raw stream event shapes
  for content block start/delta/stop.
