# Accepted Driver Failures

## Brief

Implement PRD `CAARA-trhyovch`: accepted external-agent driver failures must reach Codex as
Responses SSE `response.failed` events with actionable `response.error.message` text.

## Goal

After Caara accepts a Codex turn and begins the driver path, `AgentDriverError` failures terminate
the stream with `response.failed`, not HTTP 500 JSON, not `response.completed`, and not assistant
final-answer text. Failed accepted turns log `TurnFailed`, release the lease, and do not advance or
complete session bindings.

## Scope

In scope:

- shared Responses SSE failure encoder;
- runtime stream failure handling;
- accepted driver start/query-construction failure handling;
- Claude SDK native-binary regression through `handleResponsesCreate`;
- Antigravity regression through `handleResponsesCreate`.

Out of scope:

- request decode / malformed input behavior before the accepted driver boundary;
- broader Responses lifecycle expansion;
- Codex smoke test unless automated regressions indicate it is needed.

## Principles

- fail explicitly at IO boundaries;
- preserve actionable driver remediation text;
- no backwards-compatible fallback path hiding driver setup failures;
- use existing Effect, driver registry, lease, relay-log, and session-binding seams.

## Done Criteria

- `CAARA-onqtgijo`: runtime failures emit `response.created` then terminal `response.failed`, with
  no `response.completed`, and no binding completion.
- `CAARA-sqjmxnjp`: accepted driver start failures return HTTP 200 SSE with the same failure payload,
  release the lease, log `TurnFailed`, and allow a later turn for the same Codex thread.
- `CAARA-afxcemhv`: Claude SDK native-binary failure preserves exact remediation text in
  `response.failed.response.error.message` through `handleResponsesCreate`.
- `CAARA-zfdoeems`: Antigravity accepted driver failure preserves underlying actionable text through
  `handleResponsesCreate`.
- Each child issue has focused red tests first, passing focused validation, `bun lint`,
  `bun run test --run`, `bun run fmt`, fp completion report, and atomic commit.
- Final PRD review subagent finds no unresolved blocking gaps.

## Verification

- focused Vitest files for changed encoder/runtime/provider/driver paths;
- required slice validation: `bun lint`, `bun run test --run`, `bun run fmt`;
- independent final PRD implementation review.
