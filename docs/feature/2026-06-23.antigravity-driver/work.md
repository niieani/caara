# Antigravity Driver Work

## External References

- Official Antigravity CLI docs: https://antigravity.google/docs/cli-using
- Local CLI help: `agy --help` confirms `--prompt`, `--print`, `--conversation`, `--log-file`,
  `--model`, `--print-timeout`, `--sandbox`, `--dangerously-skip-permissions`, repeatable
  `--add-dir`.
- Real smoke note: use `agy --prompt <text>` as the non-interactive prompt shape. Do not pass a
  redundant `--print`; `agy --prompt <text> --print ...` can exit 0 without creating the requested
  log file.
- Effect child processes: `effect/unstable/process` with `ChildProcessSpawner`.

## Design

Create an `src/antigravityCliDriver/` module family:

- `options.ts`: validates raw query params, builds argv fragments.
- `prompt.ts`: extracts current-turn user input into one prompt string.
- `cursor.ts`: encodes/decodes `{"schemaVersion":1,"conversationId":"..."}`.
- `transcript.ts`: schemas + JSONL observation state.
- `events.ts`: transcript-to-runtime event mapping.
- `driver.ts`: registry integration and turn lifecycle.
- `fakeAgyHarness.ts` or test-local harness: deterministic fake CLI boundary.

Prefer a driver-owned service seam for process/log/transcript operations. Live implementation uses
Effect platform services; tests inject fake behavior without starting real `agy` unless smoke docs.

## Slice Order

1. `CAARA-ftdkqztp`: tracer bullet, fake `agy`, first-turn final answer, required hard failures.
2. `CAARA-ftqztwkm`: strict transcript observation: schemas, newline buffering, dedupe, truncation.
3. `CAARA-crhhnwvh`: option schema and exact argv.
4. `CAARA-snlfmwba`: opaque cursor resume and recovery.
5. `CAARA-fbfamjvw`: reasoning/activity mapping and privacy.
6. `CAARA-mhpxvctk`: cancellation and conservative binding recovery.
7. `CAARA-arnoyffh`: real smoke runbook/evidence.

Dependency note: PRD child tree allows options before resume/mapping; implement options before
mapping so event toggles exist when mapping tests land.

## Cancellation Slice

`CAARA-mhpxvctk` implemented live process controls for fresh Antigravity turns:

- `startAntigravityTurnProcess` returns conversation id plus `awaitExit`/`terminate` controls.
- Fresh-turn runtime events wait on process exit through an interruptible detached fiber.
- Cancellation sends `SIGTERM`, then preserves the binding only when transcript bytes are absent.
- Missing prior transcript on a preserved no-mutation resume is treated as an empty observation.
- Fake `agy` cancellation modes cover before transcript, after transcript, and in-flight activity
  bytes; focused tests assert signal logs and follow-up resume/fresh behavior.

## Smoke Slice

`CAARA-arnoyffh` real smoke corrected one CLI contract and captured evidence:

- `agy --prompt <text>` is the print-mode shape; redundant bare `--print` made real `agy` exit 0
  without writing the requested log.
- Direct canary captured stdout, log-created conversation id, transcript path, and transcript count.
- Caara first/resume smoke used real `agy`, same conversation id, and transcript append evidence.
- Activity smoke observed `tool_calls` plus `VIEW_FILE` and Responses-safe commentary.
- Reasoning smoke used `Claude Sonnet 4.6 (Thinking)`, observed transcript `thinking`, and verified
  reasoning summary SSE frames with final assistant text only.
