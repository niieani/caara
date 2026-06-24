# Antigravity activity and thinking remediation

## Symptoms

Hegel's Agy-backed Codex rollout showed repeated generic activity:

- `Running command`
- `Using list_dir`
- `Listing directory`

The underlying Antigravity turns did run specific commands and listed specific paths, but Codex did
not receive those details.

## Findings

The useful Antigravity tool metadata is usually on `PLANNER_RESPONSE.tool_calls[].args`, not on the
completed result rows.

Observed Hegel shapes:

- `run_command.args.CommandLine`
- `run_command.args.Cwd`
- `run_command.args.toolAction`
- `run_command.args.toolSummary`
- `list_dir.args.DirectoryPath`
- `list_dir.args.toolAction`
- `list_dir.args.toolSummary`

Completed rows such as `RUN_COMMAND` and `LIST_DIRECTORY` mostly contain output content only. They
do not reliably repeat the command or path. Mapping completed rows without planner context therefore
falls back to generic labels.

Antigravity tool names are also split between planner snake-case names and result enum names:

- planner: `run_command`, `list_dir`
- result rows: `RUN_COMMAND`, `LIST_DIRECTORY`

Thinking is sparse. Antigravity sometimes emits `PLANNER_RESPONSE.thinking`, and that is the only
clean public JSONL field found for reasoning-style text. Hegel's older conversation had one
`thinking` field; the post-restart conversation had none. No richer public thinking stream was found
in `.system_generated/messages` or `transcript.jsonl`. SQLite conversation DB payloads are binary and
not a suitable stable integration surface.

## Recommended Mapping

Planner tool calls:

- decode nested `args`
- normalize snake-case planner names to result enum names
- emit activity from the planner call because this is where command/path/action data lives
- enqueue the planner call as pending context for the next completed result row of the same tool

Completed tool rows:

- pair with pending planner metadata by normalized tool type
- emit terse completion only when it adds signal
- avoid raw stdout, file content, directory payloads, or JSON payload leakage
- accept unknown `MODEL/*/DONE` rows with content as opaque tool results: log a warning and ignore
  their payload instead of failing the turn

Activity text:

- `run_command` with `CommandLine` -> `Running command: \`...\``
- multiline command -> fenced `bash` code block
- `list_dir` with `DirectoryPath` -> `Listing <repo-relative-path>`
- `view_file` with file path -> `Reading <repo-relative-path>`
- `grep_search` with query/path -> `Searching <repo-relative-path>`
- `toolAction` / `toolSummary` -> fallback when no path or command exists

Thinking:

- map non-empty `PLANNER_RESPONSE.thinking` to Codex reasoning items when reasoning relay is enabled
- do not invent thinking from tool actions, summaries, stdout, or planner content
- if Codex UI shows no thinking for a turn, first verify whether the Agy transcript actually
  contains `thinking`

## Remediation

Accept Antigravity nested `args` metadata in the transcript schema and runtime mapper. Keep metadata
bounded, single-purpose, and allowlisted.

Make runtime activity state remember pending planner tool calls so result rows can reuse the richer
planner metadata. The transcript is append-only and ordered, so order-based pending correlation is
good enough for the current Antigravity JSONL contract.

Keep `transcript_full.jsonl` as the source of truth. Treat the SQLite DBs as forensic-only until
Antigravity exposes a stable documented schema.

## Completed Work

Implemented on 2026-06-24:

- shared Markdown formatting for shell command and path activity
- Antigravity nested `tool_calls[].args` decoding for command, cwd, paths, query, action, and summary
- Antigravity planner-call activity emitted from the richer planner metadata
- pending planner-call correlation for completed result rows
- quoted path activity such as `Listing \`.\`` and `Viewing \`CONTEXT.md\``
- command activity such as `Running command: \`ps aux ...\``
- multiline command activity using fenced `bash` code blocks
- duplicate low-signal completion suppression for list/view/search activity
- unknown `MODEL/*/DONE` result rows with content treated as opaque tool results: structured warning
  log, ignored raw payload, continued turn processing

Regression coverage now asserts that `MODEL/GENERIC/DONE` result rows do not fail the stream, do not
leak raw tool-result payloads to visible assistant text, and emit a structured warning log.

Additional resilience hardening was completed under fp umbrella issue `CAARA-lrpejere` on
2026-06-24:

- `CAARA-ccsjvkju`: redacted real-shape transcript replay fixtures for unknown result rows and
  out-of-order `step_index` rows
- `CAARA-wcyxivta`: structured ignored-row telemetry with thread id, turn id, row shape, step index,
  content length, and content SHA-256 without raw payload logging
- `CAARA-nnjrwwzu`: safe provider-owned diagnostic final answer for tool-only turns that exit
  without a final planner response, plus structured missing-final warning logs
- `CAARA-ektkkwzo`: semantic `step_index` ordering for completed transcript mapping and live-stream
  buffering for out-of-order rows while preserving append-only rewrite detection

## Tracked Resilience Upgrades

These were filed as one umbrella fp issue, `CAARA-lrpejere`, with independently grabbable child
issues. The umbrella context points back to this remediation doc and the 2026-06-24 unknown-result
fix charter.

1. Replay real Antigravity transcript fixtures.
   Add minimized, redacted `transcript_full.jsonl` fixtures for observed Agy shapes, including unknown
   model result rows and out-of-order `step_index` rows. The replay tests should assert runtime
   events, visible text, reasoning output, warning logs, and absence of raw transcript leakage.

2. Add structured ignored-row telemetry.
   Count ignored transcript rows by `source/type/status` and include safe context in provider logs:
   turn id, thread id, step index, content length, and optional content hash. Never log raw unknown
   row content.

3. Handle final-less tool-only turns deliberately.
   If Antigravity exits after tool results without a final planner response, return a structured
   diagnostic failure or safe provider-owned final diagnostic instead of an opaque Responses
   `response.failed` disconnect.

4. Make transcript ordering robust.
   Antigravity can append rows out of `step_index` order. Buffer or sort transcript snapshots by
   `step_index`, or correlate known result rows to pending planner calls by stronger identifiers when
   available, while preserving append-only rewrite detection.
