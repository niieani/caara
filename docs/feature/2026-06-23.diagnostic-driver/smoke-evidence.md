# Diagnostic Driver Smoke Evidence

Date: 2026-06-23

## Scope

Ran the Diagnostic driver smoke suite against a real local Caara provider process using
Codex-shaped HTTP requests. This covered the provider boundary, Responses SSE encoding, relay logs,
session directory writes, cancellation, recovery, and concurrency guard.

Codex real subagent path blocker: the current multi-agent role list exposes only the checked-in
Claude-backed `caara` role (`model = "claude/haiku"`), not Diagnostic roles. Diagnostic scenarios
that need `diagnostic/<scenario>` model selection or provider query params could not be spawned from
Codex in this thread. Follow-up issue: CAARA-feujtevl.

## Artifacts

- Provider log: `temp.local/2026-06-23/diagnostic-smoke/provider-rerun.log`
- JSON summary: `temp.local/2026-06-23/diagnostic-smoke/diagnostic-smoke-results.json`
- State directory: `temp.local/2026-06-23/diagnostic-smoke/state-rerun`
- Helper script: `temp.local/2026-06-23/diagnostic-smoke/run-diagnostic-smoke.ts`

## Commands

```bash
CAARA_STATE_DIR="$PWD/temp.local/2026-06-23/diagnostic-smoke/state-rerun" bun run start > "$PWD/temp.local/2026-06-23/diagnostic-smoke/provider-rerun.log" 2>&1
bun run temp.local/2026-06-23/diagnostic-smoke/run-diagnostic-smoke.ts
```

Provider startup evidence:

```text
Listening on http://localhost:8787
```

## Scenario Results

| Scenario | Result |
| --- | --- |
| `diagnostic/basic` first turn | `200`, `response.completed`, custom answer `custom diagnostic answer`, three text deltas |
| `diagnostic/basic` follow-up | `200`, `response.completed`, answer `Diagnostic basic resumed prior session with previous target` |
| `diagnostic/reasoning` | `200`, reasoning summary SSE events, final answer, `response.completed` |
| `diagnostic/activity` | `200`, commentary `Reading src/server.ts`, `Editing src/runtimeResponseEncoder.ts`, final answer |
| `diagnostic/activity?diagnostic_activity=off` | `200`, final answer only; relay still recorded runtime lifecycle |
| `diagnostic/fails-before-output` | `200`, terminal `response.failed`, no assistant text |
| `diagnostic/fails-after-partial` | `200`, partial reasoning SSE then `response.failed`, no assistant text |
| `diagnostic/hangs-until-cancel?diagnostic_cancel=interrupted` | stream opened with `response.created`, client abort logged `TurnCancelled` with reusable interrupted outcome |
| Held-open overlap canary | same-thread overlap returned `409`; independent thread completed with `response.completed` |
| `diagnostic/recovery?diagnostic_resume=unresumable` | recovery prompt final answer, `LostSessionRecovered`, recovered cursor persisted |
| `diagnostic/recovery?...&diagnostic_fresh_start=failure` | seeded binding remained unchanged after `500` forced fresh-start failure |
| `diagnostic/echo` first turn | echoed only `first echo request` |
| `diagnostic/echo` follow-up | echoed only `current request`; prior assistant/tool output absent |

## Relay Evidence

Every scenario selected `externalAgentKind: "diagnostic"` in `TargetSelected`; no Claude driver path
was involved.

Selected relay lines:

```json
{"event":"caara.relay","_tag":"TargetSelected","threadId":"diagnostic-smoke-basic","turnId":"diagnostic-smoke-basic-1","requestedModel":"diagnostic/basic","externalAgentKind":"diagnostic","externalModelSpecifier":"basic","rawDriverOptions":{"diagnostic_answer_text":"custom diagnostic answer","diagnostic_chunk_count":"3","diagnostic_delay_ms":"0"}}
{"event":"caara.relay","_tag":"DriverStarted","threadId":"diagnostic-smoke-basic","turnId":"diagnostic-smoke-basic-2","externalAgentKind":"diagnostic","externalSessionId":"{\"sessionId\":\"diagnostic-session-codex-thread-diagnostic-basic\"}","previousTarget":{"requestedModel":"diagnostic/basic","externalAgentKind":"diagnostic","externalModelSpecifier":"basic","rawDriverOptions":{"diagnostic_answer_text":"custom diagnostic answer","diagnostic_chunk_count":"3","diagnostic_delay_ms":"0"}}}
{"event":"caara.relay","_tag":"TurnFailed","threadId":"diagnostic-smoke-fails-before","turnId":"diagnostic-smoke-fails-before-1","message":"diagnostic driver runtime failed before output"}
{"event":"caara.relay","_tag":"TurnFailed","threadId":"diagnostic-smoke-fails-after","turnId":"diagnostic-smoke-fails-after-1","message":"diagnostic driver runtime failed after partial output"}
{"event":"caara.relay","_tag":"TurnCancelled","externalAgentKind":"diagnostic","codexThreadId":"diagnostic-smoke-hang","turnId":"diagnostic-smoke-hang-1","outcomeTag":"Interrupted","sessionReusable":true}
{"event":"caara.relay","_tag":"TurnConcurrencyConflict","externalAgentKind":"diagnostic","codexThreadId":"diagnostic-smoke-held-thread","incomingTurnId":"diagnostic-smoke-overlap-2","runningTurnId":"diagnostic-smoke-held-1"}
{"event":"caara.relay","_tag":"LostSessionRecovered","threadId":"diagnostic-smoke-recovery","turnId":"diagnostic-smoke-recovery-2","reason":"diagnostic-unresumable-session","diagnostics":{"driver":"diagnostic","previousCursor":"{\"sessionId\":\"diagnostic-session-codex-thread-diagnostic-basic\"}"}}
{"event":"caara.relay","_tag":"TurnFailed","threadId":"diagnostic-smoke-recovery-failure","turnId":"diagnostic-smoke-recovery-failure-1","message":"diagnostic driver could not resume prior session or start a fresh external session"}
```

## Binding Evidence

Observed binding files under `state-rerun/sessions/diagnostic/diagnostic/`:

- `diagnostic-smoke-basic.json`
- `diagnostic-smoke-reasoning.json`
- `diagnostic-smoke-activity.json`
- `diagnostic-smoke-activity-off.json`
- `diagnostic-smoke-hang.json`
- `diagnostic-smoke-held-thread.json`
- `diagnostic-smoke-independent-thread.json`
- `diagnostic-smoke-recovery.json`
- `diagnostic-smoke-recovery-failure.json`
- `diagnostic-smoke-echo.json`

Basic follow-up binding:

```json
{
  "requestedTarget": {
    "requestedModel": "diagnostic/basic",
    "externalModelSpecifier": "basic",
    "rawDriverOptions": {}
  },
  "lastTurnId": "diagnostic-smoke-basic-2",
  "externalSession": {
    "_tag": "Durable",
    "driverResumeCursor": "{\"sessionId\":\"diagnostic-session-codex-thread-diagnostic-basic\"}"
  }
}
```

Successful recovery binding:

```json
{
  "requestedTarget": {
    "requestedModel": "diagnostic/recovery",
    "externalModelSpecifier": "recovery",
    "rawDriverOptions": {
      "diagnostic_resume": "unresumable"
    }
  },
  "lastTurnId": "diagnostic-smoke-recovery-2",
  "externalSession": {
    "_tag": "Durable",
    "driverResumeCursor": "{\"sessionId\":\"diagnostic-session-recovered-codex-thread-diagnostic-basic\"}"
  }
}
```

Forced recovery failure preserved the seeded binding:

```json
{
  "requestedTarget": {
    "requestedModel": "diagnostic/basic",
    "externalModelSpecifier": "basic",
    "rawDriverOptions": {}
  },
  "lastTurnId": "diagnostic-smoke-recovery-failure-seed",
  "externalSession": {
    "_tag": "Durable",
    "driverResumeCursor": "{\"sessionId\":\"diagnostic-session-codex-thread-diagnostic-basic\"}"
  }
}
```

## Gaps

- Codex real subagent Diagnostic path was not executable in this thread because only the
  Claude-backed `caara` role was exposed by the multi-agent tool.
- Follow-up CAARA-feujtevl tracks adding/exposing Diagnostic Codex roles or another Codex-supported
  mechanism for scenario model and query-param selection.
