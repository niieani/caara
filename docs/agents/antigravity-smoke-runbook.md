# Antigravity Smoke Runbook

Use this flow to verify the local Caara provider through Codex's real subagent path with the
Antigravity CLI driver. Do not substitute direct `agy` or direct `/v1/responses` calls for this
smoke; those bypass the Codex subagent behavior this runbook verifies.

Keep run evidence under `temp.local/$(date +%F)/antigravity-smoke/` when collecting artifacts. Put
exact local paths in issue comments or temp evidence, not in committed docs.

## Codex Subagent Flow

1. Start the local provider:

```bash
bun run start
```

Expected startup line:

```text
Listening on http://localhost:8787
```

Optional evidence setup:

```bash
RUN_DIR="$PWD/temp.local/$(date +%F)/antigravity-smoke/$(date +%H%M%S)"
mkdir -p "$RUN_DIR"
CAARA_STATE_DIR="$RUN_DIR/state" bun run start >"$RUN_DIR/provider.log" 2>&1
```

2. Spawn a Codex subagent with `agent_type = "caara-antigravity"`.

Do not pass a `model` override. The role sets `model = "agy/gemini-3.5-flash"` and points at
`http://127.0.0.1:8787/v1`. Caara selects external agent kind `agy` from the model prefix and gives
`gemini-3.5-flash` to `agy --model`.

First-turn prompt:

```text
Please verify your working directory and read one specific source line.

1. Report your current working directory.
2. Read line 5 of README.md in that working directory.
3. Reply with exactly two fields: cwd=<your cwd> and readme_line_5=<the exact line 5 text>.
4. Do not edit files.
```

3. Wait for completion.

Expected first-turn response includes:

```text
cwd=/Volumes/Projects/Software/code-agents-as-responses-api
readme_line_5=Current implementation routes `claude/<model>` targets to Claude Code and `agy/<model>` targets to Antigravity, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.
```

4. Send a follow-up prompt on the same subagent handle:

```text
What did I just ask you to verify? Answer from this subagent conversation context. Mention the working directory check and the README.md line number.
```

Expected follow-up response: the Antigravity-backed subagent identifies the previous cwd check and
`README.md` line 5 request from the same external Antigravity conversation.

Relay evidence to check:

- `TargetSelected` requested `agy/gemini-3.5-flash`.
- `DriverStarted` used external agent kind `agy`.
- The follow-up `DriverStarted` includes an external session id and `previousTarget`.
- The first Antigravity CLI log contains `Created conversation <uuid>`.
- The follow-up external session id contains the same conversation id, and that conversation's
  `transcript_full.jsonl` line count increases after the follow-up.
- The session binding under `$CAARA_STATE_DIR/sessions/agy/agy/<codex-thread-id>.json`, or the
  default Caara state dir when `CAARA_STATE_DIR` is unset, stores a driver-owned opaque cursor.
- Runtime relay logs include normal runtime item lifecycle records.
- Tool activity appears as terse assistant commentary such as `Reading README.md`.
- Final assistant text appears as `phase = "final_answer"`.

Antigravity driver-owned evidence paths:

- CLI logs: `$HOME/.caara/antigravity-cli/logs/<codex-turn-id>.log`
- Transcript: `$HOME/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`

5. Start a long-running turn on the same handle, then close the spawned agent while it is running.

Expected observation: Caara logs `TurnCancelled` with `externalAgentKind = "agy"`. Antigravity
sessions are reusable only when cancellation happens before transcript bytes are written:

- no transcript mutation: `outcomeTag = "Interrupted"` and `sessionReusable = true`;
- transcript mutation already observed: `outcomeTag = "Terminated"` and `sessionReusable = false`.

6. Stop the local provider.

## Activity And Reasoning Checks

The standard README prompt should usually create Antigravity transcript tool activity, often with a
`VIEW_FILE` record. Responses-visible output may include terse activity commentary such as
`Reading README.md`; raw transcript payloads must not appear in Codex-visible assistant text.

Reasoning is enabled by default for the Antigravity role. If the transcript contains a `thinking`
field, Responses stream evidence should expose it only as reasoning-summary frames while final
assistant text contains the answer.

Privacy checks for captured SSE or response artifacts:

```bash
rg 'step_index|transcript_full\.jsonl|\.gemini/antigravity-cli/brain|Created conversation' "$RUN_DIR"
```

Expected: no matches in Responses-visible artifacts. Raw transcript and log paths may appear only in
local evidence files or provider logs.

## Troubleshooting

If `agent_type = "caara-antigravity"` is unavailable, check
`.codex/agents/caara-antigravity.toml` exists and includes its embedded `[model_providers.caara]`
block. A running Codex thread may need a restart before newly added role files appear in the
subagent registry.

If the subagent spawn succeeds but the turn fails, check the provider process is still listening on
`127.0.0.1:8787` and that `agy` is available on the provider process `PATH`.

If `agy` starts but cannot complete, verify local Antigravity authentication outside the committed
runbook and record the evidence under `temp.local/$(date +%F)/antigravity-smoke/`.
