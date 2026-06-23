# Antigravity Driver Work

## External References

- Official Antigravity CLI docs: https://antigravity.google/docs/cli-using
- Local CLI help: `agy --help` confirms `--prompt`, `--print`, `--conversation`, `--log-file`,
  `--model`, `--print-timeout`, `--sandbox`, `--dangerously-skip-permissions`, repeatable
  `--add-dir`.
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

