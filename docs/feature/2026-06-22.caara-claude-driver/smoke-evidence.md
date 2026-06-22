# Caara Claude Code Codex Smoke Evidence

Date: 2026-06-22

Issue: `CAARA-fojjkyfv`

## Configuration

The checked-in Codex agent profile is `.codex/agents/caara.toml`:

- `model_provider = "caara"`
- `model = "claude/haiku"`
- provider URL: `http://127.0.0.1:8787/v1`
- no provider query parameters

## First Turn

Subagent: `Averroes`

Codex thread id: `019ef1ac-9e34-7022-8104-ef07de31bec2`

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
readme_line_5=Current implementation is a mock provider for Codex: it logs request `input`,
```

Relay evidence:

- `TargetSelected` requested `claude/haiku`.
- `DriverStarted` used external agent kind `claude`.
- `RuntimeEventRelayed` relayed an assistant message.
- `TurnCompleted` completed turn `019ef1ac-a097-7750-97ca-af83eb225803`.

## Follow-Up Continuity

Prompt on the same subagent handle:

```text
What did I just ask you to verify? Answer from this subagent conversation context. Mention the working directory check and the README.md line number.
```

Observed response summary:

- Identified the previous working directory check.
- Recalled `/Volumes/Projects/Software/code-agents-as-responses-api`.
- Identified the previous `README.md` line 5 request.
- Recalled that the requested format was `cwd=` and `readme_line_5=`.

Relay evidence:

- Follow-up turn id: `019ef1ac-d35a-7f93-8987-f4835337ca74`.
- `DriverStarted` included external Claude session id `bd6de130-90df-4b47-a5e8-d79953508d41`.
- `previousTarget.requestedModel` was `claude/haiku`.
- `TurnCompleted` completed the follow-up.

## Cancellation

Subagent: `Euler`

Codex thread id: `019ef1ae-54ef-74c3-9443-3f58e47afa79`

Prompt:

```text
Write the integers from 1 to 100000, one integer per line. Start with 1. Continue until 100000. No commentary.
```

Observed behavior:

- Caara logged `DriverStarted` for turn `019ef1ae-570f-7a02-89fd-c9cf770fed7e`.
- The subagent handle was closed while the turn was running.
- `close_agent` returned `previous_status = "running"`.
- Codex later reported the spawned agent status as `shutdown`.
- Caara logged `TurnCancelled` with `outcomeTag = "Interrupted"` and `sessionReusable = true`.

## Smoke Artifacts

Uncommitted local artifacts:

- `temp.local/2026-06-22/smoke/server.log`
- `temp.local/2026-06-22/smoke/final-relay-events.json`
- `temp.local/2026-06-22/smoke/final-smoke-summary.json`

## Fixes Proven By Smoke

- Real Codex sends `x-openai-subagent = "collab_spawn"` while metadata carries `subagent_kind = "thread_spawn"`; decoder now keeps durable subagent kind from validated metadata.
- Follow-up Responses input includes prior assistant `output_text`; Claude Code prompt extraction now selects the latest user `input_text`.
- Resumed Claude Code turns no longer deadlock while previewing the first stdout line for session id discovery.
