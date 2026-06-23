# Antigravity Smoke Runbook

Use this runbook after fake `agy` tests are green to verify the real Antigravity CLI contract and
the Caara Responses path. Keep run evidence under `temp.local/$(date +%F)/antigravity-smoke/` and
put exact local paths in issue comments or temp evidence, not in committed docs.

## Direct CLI Canary

Run this first to prove local auth, model naming, log discovery, and transcript path assumptions:

```bash
RUN_DIR="$PWD/temp.local/$(date +%F)/antigravity-smoke/$(date +%H%M%S)"
mkdir -p "$RUN_DIR"

AGY_LOG="$RUN_DIR/agy-direct.log"
agy --log-file "$AGY_LOG" \
  --prompt 'ping. respond with pong.' \
  --model gemini-3.5-flash \
  --print-timeout 90s \
  >"$RUN_DIR/agy-direct.stdout" \
  2>"$RUN_DIR/agy-direct.stderr"

CID="$(rg -o 'Created conversation [0-9a-f-]+' "$AGY_LOG" | head -1 | awk '{print $3}')"
TRANSCRIPT="$HOME/.gemini/antigravity-cli/brain/$CID/.system_generated/logs/transcript_full.jsonl"
wc -l "$TRANSCRIPT"
```

Expected:

- stdout contains the model answer.
- log contains `Created conversation <uuid>`.
- transcript path exists under Antigravity user state.
- transcript contains newline-complete JSONL with a final `MODEL/PLANNER_RESPONSE/DONE` record.

Important argv contract: use `agy --prompt <text>` as the non-interactive prompt shape. Do not add
another bare `--print`; real `agy` can exit 0 without creating the requested log in that shape.

## Caara First And Resume

Start Caara with isolated state:

```bash
CAARA_STATE_DIR="$RUN_DIR/state" bun run start >"$RUN_DIR/provider.log" 2>&1
```

Send Codex-shaped `POST /v1/responses` requests with the normal required Codex identity headers.
Use the same request shape as `docs/agents/diagnostic-smoke-runbooks.md`, changing only:

- `model`: `agy/gemini-3.5-flash`
- query params:
  - `print_timeout_seconds=120`
  - `log_file=<absolute path under RUN_DIR>`
  - `reasoning=on`
  - `activity=on`
- `metadata.cwd`: repo root

First prompt:

```text
In this workspace, read README.md line 5. Reply exactly as smoke_line_5=<the exact line 5 text>. Do not edit files.
```

Follow-up prompt on the same Codex thread id:

```text
From this Antigravity conversation context, what README.md line number did I ask you to read? Include smoke_resume_line=5.
```

Expected evidence:

- Both HTTP responses have status `200`.
- First log contains `Created conversation <uuid>`.
- Session binding under `$RUN_DIR/state/sessions/agy/agy/<thread>.json` stores only an opaque
  Antigravity cursor with that conversation id.
- Resume log says it is resuming the same conversation id.
- `transcript_full.jsonl` line count increases after the resumed turn.
- Responses-visible output contains the expected final answer text.

## Reasoning, Activity, Privacy

Activity smoke:

- The README prompt should usually create transcript `tool_calls` and a `VIEW_FILE` record.
- Responses output may include terse activity commentary such as `Reading file`.
- The full `VIEW_FILE` payload must not appear in Responses-visible output.

Reasoning smoke:

- Use query option `model=Claude Sonnet 4.6 (Thinking)` with prompt:

```text
Think briefly. Then answer exactly: reasoning_smoke_ok
```

- If the transcript contains a `thinking` field, Responses SSE must contain reasoning summary
  frames and the assistant text must contain only the final answer.

Privacy checks for every SSE artifact:

```bash
rg 'step_index|transcript_full\.jsonl|\.gemini/antigravity-cli/brain|Created conversation' "$RUN_DIR"/*.sse
```

Expected: no matches in Responses SSE. Raw transcript/log paths may appear only in local evidence
files or provider logs.

## Evidence Report

Record these fields in the `fp` issue comment:

- direct `agy` command, stdout path, log path, parsed conversation id, transcript path, event count;
- Caara provider command and state directory;
- first/resume request command or helper path, log paths, session binding path, conversation id;
- transcript event count before and after resume;
- final Responses-visible output for first, resume, and reasoning turns;
- activity/reasoning shapes observed in transcript and corresponding Responses frame types;
- raw-leak search result;
- unresolved gaps, with follow-up issue ids.
