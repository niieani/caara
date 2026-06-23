# Claude SDK stream lifecycle and phases

## Problem thesis

Claude Agent SDK partial assistant output is a stream of raw Anthropic content-block events. Caara
initially treated each `text_delta` or `thinking_delta` as a complete runtime item. That violated
the Responses stream contract Caara already models elsewhere: an output item starts once, receives
zero or more text deltas, then completes once.

The visible symptom is fragmented Claude text rendered as many tiny blocks. Depending on Codex UI
surface, those fragments can look like "thinking" even when the SDK event is ordinary assistant
`text_delta`.

The second-order bug is phase classification. Claude emits ordinary assistant text before tool calls
with `stop_reason: "tool_use"`. Caara was marking that text as `final_answer`, so Halley had no way
to distinguish interim narration from the terminal answer.

## Operating theory

The correct boundary for displayable reasoning remains the SDK content block: `content_block_start`
selects the reasoning item, `content_block_delta` appends content, and `content_block_stop`
completes it. Assistant text is different because phase is not known at `content_block_start`.
Anthropic stream types carry message-level `stop_reason` in `message_delta`, after text blocks have
already started.

Completed SDK assistant messages should therefore be the authority for assistant text. They carry
complete content and `stop_reason`, letting Caara map `tool_use` text to commentary and `end_turn`
text to final answer. This sacrifices token-level assistant text streaming until a richer internal
phase-update or buffering design exists, but it preserves the visible lifecycle contract and avoids
misclassifying pre-tool narration.

Tool activity remains separately mapped to terse commentary messages. The activity text should
include safe detail when it resolves ambiguity: a Bash `tool_use` should include a bounded command
preview instead of just `Using Bash`.

## Strategy

Start with direct driver and provider-boundary regression tests for the observed Claude shape:
pre-tool text, Bash tool use, Bash result, terminal answer. The expected sequence is commentary,
commentary, commentary, final answer. This catches the exact failure where `stop_reason: "tool_use"`
was relayed as `phase: "final_answer"`.

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
  for content block start/delta/stop and message-level stop reasons.
- `docs/remediation/2026-06-23-claude-sdk-message-phase-and-activity.md`: issue record and
  recommended mapping.
