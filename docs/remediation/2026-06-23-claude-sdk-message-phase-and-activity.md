# Claude SDK message phase and activity remediation

## Symptoms

Halley showed duplicate-looking "thinking spots" during a Claude-backed subagent turn:

- `Let me reconcile...` appeared twice.
- `Using Bash` appeared twice.
- `Bash completed` appeared twice.
- The terminal answer appeared once inside the activity/thinking area and again as the final reply.

The latest relevant Codex rollout was
`~/.codex/sessions/2026/06/23/rollout-2026-06-23T14-54-03-019ef679-e112-7050-89f4-1675503d22e6.jsonl`,
turn `019ef69c-8f3c-7542-b03c-cd31d76e7747`. Its underlying Claude session was
`~/.claude/projects/-Users-bbrzoska-Documents-Projects-caara/55bcc929-67f9-4412-a2cd-5238843c513e.jsonl`.

The follow-up Opus smoke used fresh subagent `Euler`
(`019ef6da-a5f5-7910-969a-3e4ccc395715`). It showed the first fix was incomplete: the Bash activity
label included the command, but pre-tool text still landed as `phase: "final_answer"` when the SDK
message/stream shape did not expose the stop reason until a later event.

## Findings

The two `Using Bash` and `Bash completed` pairs were not bridge duplicates. Claude emitted two real
Bash `tool_use` blocks and two matching `tool_result` blocks:

- list `*.tst.ts` files in `src`
- recount total `*.ts` / `*.tsx` LOC

The real caara mapping bug was assistant text phase. Claude emitted the pre-tool text
`Let me reconcile...` with `stop_reason: "tool_use"`, but caara relayed it as a Responses assistant
message with `phase: "final_answer"`. That made Codex/Halley treat interim narration as terminal
answer text.

The terminal answer was correctly relayed as `phase: "final_answer"` because Claude emitted it with
`stop_reason: "end_turn"`. Codex also recorded the same terminal text in
`task_complete.last_agent_message`; UI consumers must treat that field as completion/copy/notification
metadata when the final item has already been rendered.

Fresh smoke evidence also showed two SDK shapes that must both classify pre-tool text as commentary:
raw assistant text buffered until `message_delta.delta.stop_reason`, and completed assistant text
with absent stop reason followed by a separate `tool_use` assistant message.

The same rule applies to orphan `text_delta` stream events that arrive without a matching
`content_block_start`: they must be buffered until a phase-bearing boundary instead of defaulting to
`final_answer`.

## Code Smells

`src/claudeAgentSdkDriver/events.ts` hardcoded completed assistant text to
`messagePhase: "final_answer"`. That erased the semantic distinction carried by Claude's
`stop_reason`.

`src/claudeAgentSdkDriver/streamEvents.ts` hardcoded streamed assistant text blocks to
`messagePhase: "final_answer"` before the stream had emitted the message-level `stop_reason`.
Anthropic raw stream events expose `stop_reason` on `message_delta`, after content blocks have
already started, so creating a visible text item at `content_block_start` is too early to classify
phase correctly.

The first remediation overcorrected by dropping raw assistant text until a completed assistant
message arrived. Real SDK streams can expose the needed phase through raw `message_delta` instead,
and some completed text messages can still have absent stop reason before a separate tool-use
message. The mapper therefore needs an explicit assistant-text buffer rather than a single authority.

`toolUseActivityText` collapsed all non-Read/Edit tools to `Using <tool>`. For `Bash`, this hides
the command that explains why multiple Bash activity entries can be legitimate.

The test suite covered single final assistant text and generic tool activity, but not the common
Claude shape `assistant text -> tool_use -> tool_result -> assistant final text`.

## Recommended Mapping

Claude assistant text:

- `stop_reason: "tool_use"` -> Responses message `phase: "commentary"`
- `stop_reason: "end_turn"` -> Responses message `phase: "final_answer"`
- raw text content blocks/deltas -> buffer until `message_delta.delta.stop_reason`
- completed text with absent stop reason -> buffer until the next assistant tool-use or terminal
  result boundary

Claude tool use:

- emit terse commentary
- include safe tool-specific detail when available
- for `Bash`, include a normalized, bounded command preview as inline code for single-line
  commands
- for multiline `Bash` commands, put the command under `Using Bash:` in a fenced `bash` code block

Claude tool result:

- emit terse commentary such as `Bash completed`
- avoid raw transcript JSON or unbounded command output

Claude thinking:

- map non-empty, displayable thinking to Codex reasoning items
- do not map thinking as assistant text

Codex `task_complete.last_agent_message`:

- use as completion/copy/notification fallback
- do not render as an additional visible message if an item-level final answer already rendered

## Remediation

Make the phase-bearing boundary the authority for assistant text phase. Raw assistant text blocks
are buffered until `message_delta` supplies `stop_reason`. Completed assistant text with no stop
reason is buffered until a following assistant `tool_use` proves it is commentary, or until terminal
success proves it is final text.

Keep tool activity derived from completed SDK assistant/user messages, where `tool_use.input` and
`tool_result.tool_use_id` are complete enough to produce useful summaries.

Add regression coverage for raw-stream and completed-message variants of a turn containing pre-tool
text, a Bash tool call, a Bash result, and a terminal answer. The expected visible message sequence
is:

1. commentary pre-tool text
2. commentary Bash command
3. commentary Bash completed
4. final answer
