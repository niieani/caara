# Claude Portable Delegation Smoke Runbook

Validates a real compiled, installed Caara user service against Claude Agent SDK. Requires working
`claude` installation and authentication.

## Preconditions

```bash
bun run build:service
./dist/caara install-service
./dist/caara doctor
```

`doctor` must report a completed portable diagnostic turn and working loopback viewer. If Claude is
missing from the service path, run `./dist/caara doctor --fix`, then restart the installed service.

## First turn

```bash
set +e
result="$(./dist/caara agent start --json \
  --target claude/sonnet --cwd "$PWD" --option effort=max \
  --prompt 'Inspect package.json and summarize the test command. Do not modify files.')"
start_status=$?
set -e
test "$start_status" -eq 10
printf '%s\n' "$result"
turn_id="$(printf '%s' "$result" | jq -r .turnId)"
while :; do
  set +e
  waited="$(./dist/caara agent wait --json --timeout-millis 30000 "$turn_id")"
  wait_status=$?
  set -e
  printf '%s\n' "$waited"
  case "$wait_status" in 0) break ;; 11) continue ;; *) exit "$wait_status" ;; esac
done
```

Accepted start intentionally exits 10; bounded working waits intentionally exit 11. The explicit
status handling keeps this runbook valid under `set -e` and waits until a terminal result.

Record `turnId`, `sessionId`, and `observationUrl`. Open the URL only in a trusted browser: its
opaque capability is a bearer secret. Expected: completed final answer; viewer activity showing
Claude's work; requested cwd/model/options honored; no detailed activity in caller output.

## Resume

```bash
set +e
resumed="$(./dist/caara agent start --json \
  --target claude/sonnet --cwd "$PWD" --option effort=max \
  --session-id "$(printf '%s' "$result" | jq -r .sessionId)" \
  --prompt 'Continue the same investigation: name the lint command.')"
resume_status=$?
set -e
test "$resume_status" -eq 10
```

Wait for `resumed.turnId` with the same terminal-wait loop used above.

Expected: same portable session, Claude continuity, no transcript/activity fields in CLI output.

## Cancellation and reuse

Start a deliberately long read-only task. Cancel its returned turn, inspect its viewer, then resume
the same session:

```bash
set +e
cancellable="$(./dist/caara agent start --json \
  --target claude/sonnet --cwd "$PWD" --option effort=low \
  --prompt 'Inspect every TypeScript source file and produce a detailed architecture review.')"
cancellable_status=$?
set -e
test "$cancellable_status" -eq 10

set +e
cancelled="$(./dist/caara agent cancel --json \
  "$(printf '%s' "$cancellable" | jq -r .turnId)")"
cancel_status=$?
set -e
test "$cancel_status" -eq 12
printf '%s\n' "$cancelled"

set +e
reused="$(./dist/caara agent start --json \
  --target claude/sonnet --cwd "$PWD" --option effort=low \
  --session-id "$(printf '%s' "$cancellable" | jq -r .sessionId)" \
  --prompt 'Reply exactly: cancellation-session-reused')"
reuse_status=$?
set -e
test "$reuse_status" -eq 10
```

Expected: `outcome: "Interrupted"`, `sessionReusable: true`; viewer shows cancelled state. A new
`agent start --session-id SESSION_ID` succeeds; wait for `reused.turnId` with the terminal-wait loop.
`Terminated` or `sessionReusable: false` indicates Claude SDK drain/finalization failure; retain
service logs and exact JSON results.

## Evidence

Capture commands, JSON outputs, viewer screenshot, `./dist/caara status`, and relevant service log
lines. Never publish observation capability URLs.

The opt-in automated form uses this installed-service path without installing, restarting, or
reconfiguring the service:

```bash
CAARA_REAL_CLAUDE_SMOKE=1 bun run test \
  src/claudeAgentSdkDriver/claudePortableInstalledSmoke.test.ts --run
```

Set `CAARA_SMOKE_CAARA_EXECUTABLE` when the installed compiled client is not `./dist/caara`.
