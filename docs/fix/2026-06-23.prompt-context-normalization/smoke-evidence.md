# Real Codex-Path Smoke Evidence

Date: 2026-06-23

Run directory: `temp.local/2026-06-23/real-smoke/105400`

Provider:

- Command: `CAARA_STATE_DIR="$PWD/temp.local/2026-06-23/real-smoke/105400/state" bun run start`
- Log: `temp.local/2026-06-23/real-smoke/105400/provider.log`
- Startup: `Listening on http://localhost:8787`

## Request Shape

The provider captured four real Codex Desktop `/v1/responses` requests: first and follow-up turns
for `caara-claude`, then first and follow-up turns for `caara-antigravity`.

Each first-turn request contained the real mixed Codex envelope:

- `developer` message with Codex/developer instructions and role-level driver instruction.
- `user` setup message with `# AGENTS.md instructions` and `<environment_context>`.
- `user` current task message with the README line-5 smoke prompt.

Each follow-up request contained the same setup envelope plus prior assistant history and the new
current user follow-up. This confirms the smoke exercised the real Codex subagent transport shape,
not a direct `/v1/responses` helper shape.

## Claude

Role: `agent_type = "caara-claude"`

Subagent id: `019ef59e-8455-76b3-a8c3-0fd185e726a0`

First-turn response:

```text
cwd=/Volumes/Projects/Software/code-agents-as-responses-api

readme_line_5=Current implementation routes `claude/<model>` targets to Claude Code and `agy/<model>` targets to Antigravity, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.
```

Follow-up response identified the prior working-directory check and README.md line 5 request from
the same subagent conversation.

Relay evidence:

- First turn: `TargetSelected` requested `claude/haiku`; `DriverStarted` external agent kind
  `claude`; `TurnCompleted`.
- Follow-up: `TargetSelected` requested `claude/haiku`; `DriverStarted` external agent kind
  `claude`; `externalSessionId = daa8e946-8816-4223-92cd-0b9c1da7c630`; `previousTarget`
  references `claude/haiku`; `TurnCompleted`.

Session binding:

```text
temp.local/2026-06-23/real-smoke/105400/state/sessions/claude/claude/019ef59e-8455-76b3-a8c3-0fd185e726a0.json
```

The binding stores durable cursor `daa8e946-8816-4223-92cd-0b9c1da7c630` and last turn
`019ef59e-b887-7e32-bcee-f5939a7db993`.

## Antigravity

Role: `agent_type = "caara-antigravity"`

Subagent id: `019ef59e-d670-7a50-bce2-3a12f49ce4a0`

First-turn response:

```text
cwd=/Volumes/Projects/Software/code-agents-as-responses-api
readme_line_5=Current implementation routes `claude/<model>` targets to Claude Code and `agy/<model>` targets to Antigravity, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.
```

Follow-up response identified the prior working-directory path and README.md line 5 verification
from the same subagent conversation.

Relay evidence:

- First turn: `TargetSelected` requested `agy/gemini-3.5-flash`; `DriverStarted` external agent kind
  `agy`; `TurnCompleted`.
- Follow-up: `TargetSelected` requested `agy/gemini-3.5-flash`; `DriverStarted` external agent kind
  `agy`; `externalSessionId` contains conversation id
  `e53c9585-173a-4a20-b4c0-6a8263ee1ab5`; `previousTarget` references
  `agy/gemini-3.5-flash`; `TurnCompleted`.

Session binding:

```text
temp.local/2026-06-23/real-smoke/105400/state/sessions/agy/agy/019ef59e-d670-7a50-bce2-3a12f49ce4a0.json
```

The binding stores durable cursor:

```json
{"schemaVersion":1,"conversationId":"e53c9585-173a-4a20-b4c0-6a8263ee1ab5"}
```

Antigravity driver evidence:

- First-turn CLI log:
  `/Users/bbrzoska/.caara/antigravity-cli/logs/019ef59e-d8e8-7e43-8d5e-015bf0fc33ee.log`
- Follow-up CLI log:
  `/Users/bbrzoska/.caara/antigravity-cli/logs/019ef59f-0ee2-7163-aa8c-9ac02b6ab546.log`
- First log line 68: `Created conversation e53c9585-173a-4a20-b4c0-6a8263ee1ab5`.
- Follow-up log lines 46-50 found and resumed the same conversation id.
- Follow-up log line 76 reported `conversation has 8 initial steps`.
- Transcript after follow-up:
  `/Users/bbrzoska/.gemini/antigravity-cli/brain/e53c9585-173a-4a20-b4c0-6a8263ee1ab5/.system_generated/logs/transcript_full.jsonl`
- Transcript line count after follow-up: `11`.

## Leak And Failure Checks

- The prompt-shape failure `Antigravity driver only supports current-turn user input_text messages`
  did not occur.
- Provider relay emitted no `TurnFailed` records for the four smoke turns.
- Responses-visible subagent output for both roles contained only the expected cwd/README answers
  and follow-up summaries. It did not expose developer instructions, AGENTS.md text,
  `<environment_context>`, transcript paths, or local log paths.

