# Claude SDK Driver Smoke Evidence

Date: 2026-06-23

Issue: `CAARA-pfgmuycx`

Commit under test: `20a47ed3f1d8b317a4c327297e0a8b6d0acea682`

## Configuration

Provider command:

```bash
bun run start
```

Observed startup:

```text
Listening on http://localhost:8787
```

Checked-in Codex agent profile: `.codex/agents/caara.toml`

- `model_provider = "caara"`
- `model = "claude/haiku"`
- provider URL: `http://127.0.0.1:8787/v1`
- no provider query parameters for the standard Codex subagent smoke

Production entrypoint evidence:

- `src/caara.ts` composes `claudeAgentSdkDriverLive`.
- `src/claudeAgentSdkDriver/claudeCliRetirement.test.ts` is the architecture regression for no retired `claudeCodeDriver`, no `claudeCodeContract`, and no direct `Bun.spawn` under `src`.

## First Turn

Subagent: `Bernoulli`

Codex thread id: `019ef385-233d-7f51-be49-f06623bbfed9`

Prompt:

```text
Please verify your working directory and read one specific source line.

1. Report your current working directory.
2. Read line 5 of README.md in that working directory.
3. Reply with exactly two fields: cwd=<your cwd> and readme_line_5=<the exact line 5 text>.
4. Do not edit files.
```

Observed response:

```text
cwd=/Volumes/Projects/Software/code-agents-as-responses-api
readme_line_5=Current implementation routes `claude/<model>` targets to Claude Code, persists session bindings, resumes follow-up turns, and cancels in-flight work when Codex disconnects.
```

Relay evidence:

- Request targeted `model = "claude/haiku"`.
- `TargetSelected` selected external agent kind `claude`.
- `DriverStarted` started the SDK-backed Claude driver.
- Stream included activity commentary for tool use, including `Using Bash`, `Bash completed`, `Reading /Volumes/Projects/Software/code-agents-as-responses-api/README.md`, and `Read completed`.
- Stream completed with `TurnCompleted`.

## Follow-Up Continuity

Prompt on the same subagent handle:

```text
What did I just ask you to verify? Answer from this subagent conversation context. Mention the working directory check and the README.md line number.
```

Observed response:

```text
You asked me to verify:

1. **Working directory check** - report the current working directory (`pwd`)
2. **README.md line 5** - read and extract the exact text from line 5 of README.md in that directory
3. **Reply format** - provide exactly two fields: `cwd=<path>` and `readme_line_5=<text>`

I confirmed the working directory is `/Volumes/Projects/Software/code-agents-as-responses-api` and retrieved line 5 from its README.md file.
```

Relay evidence:

- Follow-up submission id: `019ef385-84f9-7012-abb5-eb74e55d5e79`.
- `DriverStarted` included the prior external Claude session id for the same Codex thread.
- `previousTarget.requestedModel` was `claude/haiku`.
- Follow-up stream completed with `TurnCompleted`.

## Cancellation

Subagent: `Beauvoir`

Codex thread id: `019ef386-d061-7770-a320-7c4441cde0fb`

Prompt:

```text
Write the integers from 1 to 100000, one integer per line. Start with 1. Continue until 100000. No commentary.
```

Observed behavior:

- `close_agent` returned `previous_status = "running"`.
- Codex later reported the spawned agent status as `shutdown`.
- Caara logged:

```json
{
  "_tag": "TurnCancelled",
  "externalAgentKind": "claude",
  "codexThreadId": "019ef386-d061-7770-a320-7c4441cde0fb",
  "turnId": "019ef386-d23b-77c3-afd3-52f270b97b7c",
  "outcomeTag": "Interrupted",
  "sessionReusable": true
}
```

## Direct Provider Option And Recovery Checks

Supplemental direct-provider smoke used Codex-shaped HTTP requests against the same live server.
The helper is ignored under `temp.local/2026-06-23/smoke-sdk/run-live-provider-smoke.ts`.

Command:

```bash
bun temp.local/2026-06-23/smoke-sdk/run-live-provider-smoke.ts
```

Summary artifact:

```text
temp.local/2026-06-23/smoke-sdk/live-provider-smoke-a0e8d6e6-23ad-478c-a105-2b11ee30dbb3.json
```

Run id: `a0e8d6e6-23ad-478c-a105-2b11ee30dbb3`

Activity default-on request:

- URL: `/v1/responses?tools=default`
- Prompt requested Bash `pwd`.
- Status: `200`.
- Completed assistant messages included:
  - `phase = "commentary"`, text `Using Bash`
  - `phase = "commentary"`, text `Bash completed`
  - `phase = "final_answer"`, text `activity-default-complete`
- Stream included `response.reasoning_summary_text.delta`, so displayable reasoning mapping was exercised by the live SDK path.

Activity opt-out request:

- URL: `/v1/responses?tools=default&activity=off`
- Prompt requested Bash `pwd`.
- Status: `200`.
- Completed assistant messages included only final-answer messages.
- Commentary message count: `0`.
- Relay logs still recorded runtime item lifecycle events for the turn.

Reserved interactive tool request:

- URL: `/v1/responses?allowed_tools=AskUserQuestion`
- Status: `500`.
- Body:

```json
{
  "error": {
    "type": "server_error",
    "message": "Claude Agent SDK allowed_tools cannot allow AskUserQuestion; it is reserved for unsupported interactive questions."
  }
}
```

Lost-session recovery request:

- First turn thread id: `smoke-sdk-recovery-a0e8d6e6-23ad-478c-a105-2b11ee30dbb3`.
- Initial binding cwd: `/Volumes/Projects/Software/code-agents-as-responses-api`.
- Follow-up supplied cwd: `/Volumes/Projects/Software`.
- Caara logged `LostSessionRecovered` with `reason = "cwd-changed"`.
- Follow-up response emitted the Caara-owned recovery text:

```text
I lost the external agent session context. Remind me, what did we discuss prior to this message, restate any relevant context and your request.
```

- Binding cursor changed from `be10f1d0-98dc-445a-8c1e-2f82874b2638` to `1591afeb-c347-44d1-b929-88da9d58b2b7`.
- Binding cwd changed to `/Volumes/Projects/Software`.

## Input Mapping

The real Codex subagent first turn validated current text input mapping through the Responses
history sent by Codex. The direct provider smoke used current-turn `input_text` only.

Image and path-based input mapping were already covered by focused SDK prompt tests during
`CAARA-iqbzhbva`; they were not repeated in the manual smoke.

## Known Observations

- Direct synthetic SDK streams can expose duplicate `phase = "final_answer"` message items for a
  short exact-answer prompt, while the real Codex subagent final answer presented once. The duplicate
  comes from the live SDK stream shape exercising both aggregate assistant message content and text
  deltas. This did not block the SDK-backed subagent smoke, but future stream cleanup should consider
  coalescing the live SDK final-answer path.
