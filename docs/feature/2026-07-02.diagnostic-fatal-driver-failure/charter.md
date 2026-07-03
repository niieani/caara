# Diagnostic Fatal Driver Failure

## Brief

Add a Diagnostic driver scenario that emits a terminal `response.failed` with a Codex-fatal
error code, so we can empirically verify whether spawned subagents surface Caara driver errors
instead of classifying them as retryable/high-demand failures.

## Goal

`diagnostic/fails-invalid-request` streams:

- `response.created`
- `response.failed`

The failed response preserves the existing user-visible message prefix and uses
`error.code = "invalid_prompt"`, the code Codex maps to `InvalidRequest`.

## Scope

In scope:

- Runtime failed response error-code support.
- Diagnostic scenario and checked-in Codex role.
- Focused encoder and HTTP provider tests.

Out of scope:

- Reclassifying all Claude option errors.
- Changing Codex client behavior.
- Broad public docs.

## Criteria

- Pure runtime encoder test proves failed events can carry `invalid_prompt`.
- HTTP provider test proves `diagnostic/fails-invalid-request` streams failed response with the
  expected code and message.
- Checked-in `.codex/agents` role exists for manual spawn testing.
- Focused tests pass with `bun run test`.
