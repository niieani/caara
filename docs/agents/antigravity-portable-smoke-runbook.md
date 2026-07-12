# Antigravity Portable Delegation Smoke Runbook

Validates the compiled CLI against an already-installed Caara user service and real authenticated
`agy`. It never installs, restarts, or reconfigures the service.

## Preconditions

```bash
bun run build:service
./dist/caara status
./dist/caara doctor
```

`doctor` must report a completed portable diagnostic turn. The installed service environment must
resolve authenticated `agy`; use `doctor --fix` and restart separately if it does not.

## First turn and viewer

```bash
set +e
started="$(./dist/caara agent start --json \
  --target agy/gemini-3.5-flash --cwd "$PWD" --option effort=high \
  --prompt 'Inspect package.json and summarize the test command. Do not modify files.')"
start_status=$?
set -e
test "$start_status" -eq 10
turn_id="$(printf '%s' "$started" | jq -r .turnId)"
```

Open `observationUrl` only in a trusted browser; the opaque capability is a bearer secret. Caller
JSON exposes identifiers and final-only state, never Antigravity reasoning, transcript, or tool
activity. Viewer activity should show Antigravity work. Check service logs or a controlled fake
`agy` boundary when exact cwd, model, effort mapping, sandbox, and options argv evidence is needed.

Wait with explicit accepted/working statuses:

```bash
while :; do
  set +e
  waited="$(./dist/caara agent wait --json --timeout-millis 30000 "$turn_id")"
  wait_status=$?
  set -e
  case "$wait_status" in 0) printf '%s\n' "$waited"; break ;; 11) continue ;; *) exit "$wait_status" ;; esac
done
```

## Resume and concurrency

Start a follow-up using `--session-id "$(printf '%s' "$started" | jq -r .sessionId)"`. Expect exit
10, the same portable session, and continuity from the first Antigravity conversation. While that
resumed turn is working, a second start using the same session must fail with HTTP/CLI concurrency
conflict; an unrelated new session remains independent.

## Conservative cancellation

Start a long turn, wait until its viewer reports Antigravity activity, then cancel:

```bash
set +e
cancellable="$(./dist/caara agent start --json \
  --target agy/gemini-3.5-flash --cwd "$PWD" --option effort=high \
  --prompt 'Inspect every TypeScript source file and produce a detailed architecture review.')"
cancellable_status=$?
set -e
test "$cancellable_status" -eq 10
cancellable_turn_id="$(printf '%s' "$cancellable" | jq -r .turnId)"

# Open cancellable.observationUrl in a trusted browser and wait for visible activity.
set +e
cancelled="$(./dist/caara agent cancel --json "$cancellable_turn_id")"
cancel_status=$?
set -e
test "$cancel_status" -eq 12
printf '%s\n' "$cancelled"
```

Once Antigravity transcript mutation was observed, expected policy is `outcome: "Terminated"` and
`sessionReusable: false`; never resume that session. Cancellation before transcript mutation may be
`Interrupted` and reusable. Preserve the exact JSON, viewer screenshot, service logs, and `agy`
transcript evidence when the boundary is ambiguous. Never publish capability URLs.

## Opt-in installed smoke

```bash
CAARA_REAL_AGY_SMOKE=1 bun run test \
  src/antigravityCliDriver/antigravityPortableInstalledSmoke.test.ts --run
```

Set `CAARA_SMOKE_CAARA_EXECUTABLE` when the compiled client is not `./dist/caara`. The smoke handles
exit 10 (accepted), 11 (still working), and 12 (cancelled), with a 120-second terminal wait ceiling.
