# Authenticated Smoke Testing

This is the entrypoint for Caara smoke tests that invoke authenticated, metered Agent harnesses.
Run them only when the user explicitly asks. The executable smoke specifications are Markdown
prompts under `docs/agents/smoke-prompts/`; authenticated smoke tests never belong in Vitest or
other checked-in executable test code.

Automated tests must intercept or simulate the Codex, Claude, and Antigravity boundaries. Use
`docs/agents/diagnostic-smoke-runbooks.md` for non-authenticated Responses-path checks.

This document is also the smoke-forensics knowledge base. When reorganizing it, preserve detailed
join procedures, comparison rules, exact failure signatures, and canaries in place or move them to
a linked document. Do not replace operational troubleshooting knowledge with a summary.

## Portfolio

| Surface | Target | Prompt | State |
| --- | --- | --- | --- |
| CLI | Claude | `smoke-prompts/cli-claude.md` | runnable |
| CLI | Antigravity | `smoke-prompts/cli-antigravity.md` | runnable |
| CLI | Codex | `smoke-prompts/cli-codex.md` | runnable |
| MCP | one different real harness | `smoke-prompts/mcp-cross-harness.md` | runnable when MCP is configured |
| Responses API | Claude | `smoke-prompts/responses-claude.md` | opt-in workaround; do not run by default |
| Responses API | Antigravity | `smoke-prompts/responses-antigravity.md` | opt-in workaround; do not run by default |
| User service | installation lifecycle | `smoke-prompts/service-installation.md` | separate; mutates global user state |

The portfolio covers each real driver through the direct CLI without building an
orchestrator-by-target matrix. MCP uses one known MCP-capable orchestrator and one different real
target. Responses smokes specifically use real Codex because Codex's subagent transport is the
contract under test.

## Responses Role Fixtures And Discovery

Checked-in real-agent roles:

- `caara-claude`: Claude SDK driver with `claude/haiku`;
- `caara-claude-fable`: Claude SDK driver with `claude/fable`;
- `caara-antigravity`: Antigravity CLI driver with `agy/gemini-3.5-flash`.

These are repository smoke fixtures, not the public installation contract. Generated installed
roles use driver variants such as `caara-claude-haiku`, `caara-claude-sonnet`,
`caara-agy-gemini-3-5-flash`, and `caara-agy-gpt-oss-120b`.

Codex role discovery is not guaranteed to hot-reload. Start a fresh Codex task after generating,
copying, or removing roles before reporting discovery failure. For installer-only checks, generate
roles into an explicit temporary target under the run directory rather than changing global Codex
state.

## Authorization And Safety

- Confirm explicit user authorization immediately before any authenticated smoke.
- State which harnesses and models will incur usage.
- Do not run an authenticated prompt while implementing or running the normal test suite.
- Do not install, stop, restart, or reconfigure the user service unless the requested playbook
  explicitly owns that operation.
- Do not modify repository files during a smoke. Prompts require read-only target work.
- Store logs, JSON, viewer HTML, process snapshots, and temporary model catalogs under
  `temp.local/$(date +%F)/<smoke-name>/<timestamp>/`.
- Never publish observation capability URLs or authenticated harness transcripts.

## Global Compiled-Service Setup

CLI, MCP, and Responses smokes exercise the current compiled artifact, not the separately installed
binary. The smoke executor owns the provider process.

1. Build:

```bash
bun run build:service
```

2. Prove no installed/stale service owns the default endpoint:

```bash
set +e
./dist/caara status >"$RUN_DIR/preflight-status.txt" 2>&1
status_code=$?
set -e
test "$status_code" -ne 0
test -z "$(lsof -nP -iTCP:8787 -sTCP:LISTEN 2>/dev/null)"
```

Fail if either check finds a listener. Do not silently reuse or stop it. Ask the user to stop the
installed service, or run the separate installation lifecycle playbook when that is the requested
scope.

3. Start an owned provider and retain its output. A detached tmux session is appropriate because
the process must persist across agent tool calls:

```bash
SMOKE_SESSION="caara-smoke-$(date +%H%M%S)"
tmux new-session -d -s "$SMOKE_SESSION" \
  "cd '$PWD' && CAARA_STATE_DIR='$RUN_DIR/state' exec ./dist/caara >'$RUN_DIR/provider.log' 2>&1"
```

Wait on the live startup output, then verify health; do not add an arbitrary sleep:

```bash
tail -n +1 -f "$RUN_DIR/provider.log" | rg -m1 'Listening on http://localhost:8787'
./dist/caara status
```

4. On every exit path, stop only the owned tmux session:

```bash
tmux kill-session -t "$SMOKE_SESSION"
```

The service-installation smoke is intentionally separate so these driver/adapter smokes cannot pass
against a stale installed binary or conflate driver behavior with installation behavior.

## Shared Three-Turn Lifecycle Contract

Every real-target smoke verifies the same lifecycle.

### Turn 1: initial dispatch

- Generate a unique nonce with `uuidgen`.
- Ask the target to remember the nonce, inspect `package.json` read-only, and return a short exact
  marker containing the nonce.
- Assert the selected target, requested cwd, model, and driver options.
- Assert an accepted start becomes working or completed and then completes successfully.
- Record the durable `turnId`, `sessionId`, and observation URL when the adapter exposes them.

### Turn 2: explicit follow-up

- Resume the exact session/handle from turn 1.
- Ask which nonce and file appeared in the initial request.
- Require an exact response containing both the nonce and `package.json`.
- Assert the session identity is unchanged and the underlying external harness resumed its prior
  conversation rather than silently starting fresh.

### Turn 3: follow-up cancellation

- Resume the same session again with a long, read-only repository investigation.
- Establish a causal boundary before cancelling: viewer activity, runtime tool activity, or a
  target process known to be running. Never use `sleep` as proof that work started.
- Capture `ps -axo pid=,ppid=,command=` before cancellation and identify the unique harness process
  owned by the smoke provider. If identification is ambiguous, fail the smoke.
- Cancel/close the exact running turn.
- Require the cancellation operation to return only after the harness process exits. Capture a
  second process snapshot and prove the recorded PID no longer exists (`kill -0 PID` must fail).
- Assert no later activity arrives for the cancelled turn.
- Assert target-specific cancellation outcome and session reusability.

Cancellation result alone is not subprocess-exit evidence. If a driver cannot expose or correlate
its real child process reliably, report a smoke blocker; do not downgrade the assertion.

## Blindness And Viewer Contract

For CLI and MCP:

- start exposes identifiers, coarse state, and `observationUrl` only;
- working waits expose identifiers and the same observation URL;
- terminal wait exposes the final answer or typed terminal outcome only;
- no result/error contains reasoning, commentary, tool activity, transcript fields, viewer HTML, or
  private activity sentinels;
- the capability viewer contains live activity and the correct terminal state.

The smoke executor is a trusted verifier and may fetch the viewer to assert the human plane. An MCP
or managing Agent receiving `observationUrl` must surface it to the user and must never open it,
pass it to another tool, or summarize it.

## CLI Adapter

Use only the compiled artifact:

```bash
./dist/caara agent start --json --target TARGET --cwd "$PWD" \
  --option effort=low --prompt 'PROMPT'
./dist/caara agent wait --json --timeout-millis 30000 TURN_ID
./dist/caara agent cancel --json TURN_ID
```

Contract exit codes:

- `10`: accepted start;
- `11`: bounded wait remains working;
- `0`: completed wait;
- `21`: cancelled result.

Handle these codes explicitly under `set -e`. Repeated bounded waits are allowed; a timed-out wait
must not cancel the turn.

## MCP Adapter

Caara exposes exactly `caara_agent_start`, `caara_agent_wait`, and `caara_agent_cancel` over stdio.
It exposes no observation reader, transcript resource, prompt, or MCP Task dependency.

Codex has no scoped `mcp add`. Configure Caara only for the current invocation with `-c`; this does
not write `~/.codex/config.toml`:

```bash
CAARA_BIN="$PWD/dist/caara"
codex \
  -c "mcp_servers.caara-agent.command=\"$CAARA_BIN\"" \
  -c 'mcp_servers.caara-agent.args=["agent-mcp"]'
```

The same overrides work with `codex exec`. The keys follow the official
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
for `mcp_servers.<id>.command` and `mcp_servers.<id>.args`.

Claude Code supports a persistent project-local scope. Add and remove only that local entry:

```bash
claude mcp add --scope local caara-agent -- "$PWD/dist/caara" agent-mcp
claude mcp remove --scope local caara-agent
```

Never use `codex mcp add` or Claude's user scope for a smoke. Start a fresh orchestrator session so
MCP discovery is not mistaken for hot reload. The orchestrator harness and selected Caara target
must differ; same-harness delegation is expected to be rejected once that policy is implemented.

## Responses API Through Real Codex

These smokes are documented but not run by default. Current Codex MultiAgentV2 encrypts delegated
task text before sending it to a custom Responses provider. Until upstream behavior changes, use a
temporary patched model catalog with `multi_agent_version: null` for the selected GPT-5.6 model and
per-invocation overrides—no temporary `config.toml` is needed:

```bash
codex \
  -c 'model_catalog_json="/absolute/path/to/patched-models.json"' \
  -c 'features.multi_agent=true' \
  -c 'features.multi_agent_v2=false'
```

Verify the installed Codex version before applying the workaround. Apply other catalog overrides
only when still required by that version. Reference:
`https://github.com/openai/codex/issues/31814#issuecomment-4948837758`.

Use the checked-in Caara roles in a fresh Codex task. The Responses smoke uses Codex's real native
subagent handle for initial dispatch, follow-up, and interruption. It does not substitute direct
HTTP requests for the contract.

### Responses relay presentation checks

Retained provider logs should show:

- `TargetSelected` with the requested external agent kind/model;
- `DriverStarted`, including the external session id and `previousTarget` on follow-up;
- `RuntimeEventRelayed` item lifecycle records;
- tool activity as assistant `phase = "commentary"`;
- final assistant text as `phase = "final_answer"`;
- `TurnCancelled` with cancellation outcome and session reusability for the interrupted third turn.

Single-line shell activity should render as `Using Bash:` plus an inline-code command. Multiline
shell activity should render under `Using Bash:` in a fenced `bash` block. Tool completion should be
a separate commentary message. Missing commentary, tool text marked final, or the final answer
rendered twice requires rollout-to-target-log comparison below.

To verify Codex advisory effort serialization, change the Codex effort selector and inspect the
retained request log:

```bash
rg '"event":"caara.responses.request"|"reasoning"|"effort"' "$RUN_DIR/provider.log"
```

The request body should contain the selected `reasoning.effort`. Driver-owned options still win;
for example, Claude's `query_params.effort` remains the way to request Claude-only `max`.

### Supplemental Claude scoped-permission canary

The checked-in `caara-claude` role carries smoke-specific settings equivalent to:

```toml
query_params = { additional_directories = "$TMPDIR", allowed_tools = "Write($TMPDIR/caara-panel/smoke/**),Edit($TMPDIR/caara-panel/smoke/**)", permission_mode = "dontAsk" }
```

This adds process TMPDIR visibility while restricting pre-approved writes to the smoke subtree. It
does not pre-approve Bash. When explicitly testing this permission contract, create the parent
directory first and give Claude the expanded absolute path:

```bash
SMOKE_FILE="${TMPDIR%/}/caara-panel/smoke/caara-claude.md"
mkdir -p "$(dirname "$SMOKE_FILE")"
test ! -e "$SMOKE_FILE"
printf '%s\n' "$SMOKE_FILE"
```

Prompt:

```text
Create an empty file at <absolute SMOKE_FILE> using the Write tool only.
Do not use Bash. Do not write anywhere else.
Reply only with the absolute path you created.
```

Expected evidence:

```bash
test -f "$SMOKE_FILE"
test ! -s "$SMOKE_FILE"
rg '"_tag":"PermissionDenied".*caara-claude.md|PermissionDenied.*caara-claude.md' \
  "$RUN_DIR/provider.log"
```

Both `test` commands must succeed and the `rg` command must find nothing. Move any pre-existing
fixture aside under the run directory; never overwrite it.

## Evidence And Debugging

Retain:

- `provider.log`;
- every CLI/MCP/Responses result stream;
- capability viewer HTML snapshots before and after terminal state;
- before/after process snapshots and the asserted harness PID;
- target-native transcript/session identifiers when available;
- exact executable versions and command lines;
- a concise `result.md` listing every assertion and pass/fail state.

Useful joins:

- Codex rollouts: `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`;
- Claude sessions: locate the file using the external session id from `DriverStarted`;
- Antigravity transcripts: use the conversation id from its CLI log under
  `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/`;
- Caara: join `turnId`, `sessionId`, `DriverStarted`, `RuntimeEventRelayed`, `TurnCompleted`, and
  `TurnCancelled` in `provider.log`.

Failure localization:

- duplicated activity already present in the native target transcript: upstream harness behavior;
- one native event but duplicated Caara lifecycle items: driver normalization/Responses encoding;
- viewer contains activity but CLI/MCP result does too: blindness regression;
- cancellation returned while PID remains: driver cancellation regression;
- follow-up misses nonce or changes external session: resume regression;
- role absent only in an existing Codex task: restart Codex before reporting role installation
  failure.

## Matching Codex Rollouts To Target Logs

Use this when a smoke shows duplicated reasoning/tool text, a wrong message phase, missing live
activity, a final answer twice, or disagreement between the caller and capability viewer.

### Find the Codex rollout

Codex rollout logs show what Codex received after Caara translated driver runtime events. They live
under `~/.codex/sessions/<year>/<month>/<day>/`. When the spawned subagent id is known:

```bash
SUBAGENT_ID="019ef6e3-3cc6-7cf0-afe0-8f8d94647a72"
find "$HOME/.codex/sessions" -name "rollout-*-${SUBAGENT_ID}.jsonl" -print | sort | tail -1
```

Retain the matched rollout under the smoke run directory without editing the original.

### Join a Claude session

Claude Code session logs show what the SDK-backed agent emitted before Caara mapping. The exact
project-directory encoding can vary, so prefer the external session id rather than guessing the
directory from the workspace path.

Find the session id in the retained Caara log:

```bash
rg '"_tag":"DriverStarted"|externalSessionId|threadId|turnId' "$RUN_DIR/provider.log"
```

`externalSessionId` contains a JSON payload with `sessionId`. Find the corresponding file:

```bash
CLAUDE_SESSION_ID="388cd466-9767-4652-9604-d1ea7b86cc4e"
find "$HOME/.claude/projects" -name "${CLAUDE_SESSION_ID}.jsonl" -print
```

If the provider log is unavailable, inspect recent Claude logs around the Codex rollout timestamp,
then match prompt nonce, tool command, and turn order:

```bash
find "$HOME/.claude/projects" -name '*.jsonl' -print0 \
  | xargs -0 ls -t | head -5
```

### Join an Antigravity conversation

Use the conversation id from Antigravity's diagnostic log. The transcript is normally under:

```text
~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl
```

Correlate transcript `step_index`, tool records, final response, and process exit with Caara's
`turnId`, `DriverStarted`, `RuntimeEventRelayed`, and `TurnCancelled` records. A transcript-mutated
cancellation should follow the conservative non-reusable policy.

### Comparison rules

- If the native target log contains duplicated tool-use/tool-result records, duplicated commentary
  in Codex or the viewer is probably real upstream activity.
- If the native target emits one tool call but the Codex rollout or viewer contains duplicate
  assistant lifecycle items, inspect driver normalization and Responses encoding.
- Claude pre-tool assistant text followed by `tool_use` must reach Codex as
  `phase = "commentary"`; `phase = "final_answer"` indicates phase-mapping failure.
- One final assistant message plus identical text in `task_complete.last_agent_message` is one
  visible answer plus completion metadata. Rendering both is a client/UI duplication bug.
- Viewer-only activity absent from CLI/MCP is correct. The same private sentinel in CLI/MCP output
  is a blindness regression.
- A cancellation response before the correlated harness PID exits is a driver cancellation bug,
  even if the terminal JSON shape is otherwise correct.

## Supplemental Direct Responses Checks

Direct Codex-shaped HTTP requests are supplemental protocol probes, not substitutes for the real
Codex Responses smoke. Use them only for provider options that a checked-in role cannot pass, such
as activity suppression or deliberately invalid driver options. Keep request bodies and output
under the run directory.

Recommended probes:

- `?tools=default`: ask the target to use a tool and verify commentary is visible.
- `?tools=default&activity=off`: verify caller-visible commentary is absent while relay lifecycle
  records remain.
- `?permission-mode=auto`: verify Claude rejects the unsupported option as `invalid_prompt`.
- `?allowed_tools=AskUserQuestion`: verify the reserved interactive tool fails validation.
- Same synthetic thread id with a changed cwd: verify `LostSessionRecovered`, the Caara-owned
  recovery message, and a new durable driver resume cursor.

### Claude invalid-option failure canary

Use this when Codex displays provider-demand/retry wording instead of Caara's nonretryable request
error.

Direct-provider URL:

```text
/v1/responses?permission-mode=auto
```

Use the Codex-shaped body and headers from
`docs/agents/diagnostic-smoke-runbooks.md#common-setup`, with `model = "claude/haiku"`.

Expected SSE:

- HTTP `200` with `content-type: text/event-stream`;
- `response.created`, then `response.failed`;
- `response.error.code = "invalid_prompt"`;
- exact message:
  `Caara driver failed: Unsupported Claude Agent SDK driver option: permission-mode.`;
- no `response.completed`.

For the native Codex-path canary, copy the role into the run directory, add only this invalid query
parameter, and point the smoke-specific Codex invocation at that temporary role:

```toml
query_params = { "permission-mode" = "auto" }
```

The expected visible failure is the exact message above. Provider high-demand wording means Codex
error-code mapping regressed. Automated reference:
`src/claudeAgentSdkDriver/claudeAgentSdkActivity.test.ts`, test
`surfaces invalid Claude driver options as invalid_prompt response failures`.

## Claude SDK Architecture Checks

Use these checks when a Claude smoke accidentally appears to exercise a retired CLI adapter:

- `src/caara.ts` composes `claudeAgentSdkDriverLive`.
- `src/claudeAgentSdkDriver/claudeCliRetirement.test.ts` passes; it rejects the retired
  `claudeCodeDriver`, retired `claudeCodeContract`, and direct driver-owned `Bun.spawn` path.
- Smoke logs show `TargetSelected` and `DriverStarted` for external agent kind `claude`, not retired
  Claude CLI argv/stdout JSONL records.
- Cancellation evidence uses the SDK runtime/session and its correlated subprocess lifecycle, not
  the Antigravity/Codex CLI process adapter.

## Common Failure Signatures

- Role unavailable: confirm the matching `.codex/agents/*.toml` exists, contains its embedded
  `[model_providers.caara]` block, and start a fresh Codex task.
- Spawn succeeds but turn fails: confirm the smoke-owned provider still listens on
  `127.0.0.1:8787`, then inspect `provider.log` before retrying.
- Codex rejects a role config: keep the provider block inside each role; project-level
  `.codex/config.toml` alone does not satisfy role-layer validation.
- CLI start exits `69`: service endpoint/config mismatch or provider not running.
- Wait remains `working`: inspect viewer and driver process evidence; do not increase timeouts before
  identifying the causal boundary.
- Follow-up forgets the nonce: compare portable `sessionId`, external resume cursor/session id, and
  target-native transcript before rerunning.
- Cancellation returns `Interrupted` for transcript-mutated Antigravity: activity boundary was not
  established or conservative cancellation policy regressed.
- Cancellation returns but PID remains: retain both process snapshots and report a safe-cancellation
  contract failure.
