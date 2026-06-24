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
