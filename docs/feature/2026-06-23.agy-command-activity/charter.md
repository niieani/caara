# Agy activity metadata

Improve Antigravity activity commentary using real transcript metadata.

Goal: when Antigravity planner tool calls include nested `args`, Caara emits visible commentary with safe command/path/action details instead of repeated generic labels.

In scope:
- Antigravity transcript-to-runtime activity mapping.
- Antigravity transcript schema for safe nested tool-call args.
- Pending planner-tool-call context used by completed result rows.
- Focused transcript mapping tests.
- Remediation note in `docs/remediation/`.

Out of scope:
- Claude SDK activity mapping, except shared formatter compatibility.
- Reverse-engineering Antigravity SQLite/protobuf payloads.
- Inventing thinking when `PLANNER_RESPONSE.thinking` is absent.

Criteria:
- `run_command` planner calls with `args.CommandLine` render command text like the Claude Bash activity formatter: inline code for one-line commands, fenced shell block for multiline commands. Verifier: `src/antigravityCliDriver/transcript.test.ts`.
- `list_dir` planner calls with `args.DirectoryPath` render a concrete listing target. Verifier: same focused tests.
- Snake-case planner tool names normalize to existing completed-result tool names. Verifier: same focused tests.
- Completed result rows can reuse pending planner metadata without leaking raw output. Verifier: same focused tests.
- Empty or unsafe/missing command still falls back to `Running command` or bounded `toolAction` / `toolSummary`. Verifier: same focused tests.
- Raw command output / transcript payload remains hidden. Verifier: existing leak test updated to allow only safe command metadata.
- Existing activity opt-out behavior unchanged. Verifier: focused test file plus relevant provider-boundary activity test if needed.
- Sparse Agy thinking behavior is documented: relay only real `thinking` fields. Verifier: remediation doc review.

Execution: small direct TDD change; restart the tmux smoke provider after validation so manual follow-up uses the new mapper.
