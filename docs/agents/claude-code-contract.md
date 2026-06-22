# Claude Code invocation contract

Observed on 2026-06-22 with `/Users/bbrzoska/.local/bin/claude`,
`2.1.185 (Claude Code)`.

Committed harness:

- `src/claudeCodeContract/invocation.ts` builds spawn-ready `claude` argv.
- `src/claudeCodeContract/runHarness.ts` can run the isolated probe in a chosen cwd.
- `src/claudeCodeContract/streamEvents.ts` parses and summarizes stream-json lines.

Local evidence artifacts are under `temp.local/2026-06-22/claude-contract/`.

## Required print-mode shape

Use print mode with verbose stream-json:

```bash
claude -p --verbose --output-format stream-json \
  --model haiku \
  --effort low \
  --max-budget-usd 0.02 \
  --tools "" \
  "Reply with exactly CAARA_HAIKU_OK and nothing else."
```

`--output-format stream-json` without `--verbose` is rejected:
`When using --print, --output-format=stream-json requires --verbose`.

Useful options shown by `claude --help`:

- `--model <model>` accepts aliases and full names.
- `--effort low|medium|high|xhigh|max`.
- `--max-budget-usd <amount>` in print mode.
- `--tools ""` disables tools; init event then reports `tools: []`.
- `--resume <session-id>` resumes by session id.
- `--session-id <uuid>` can pin a new session id.
- `--debug-file <path>` writes debug logs.
- `--include-partial-messages` emits partial message chunks in stream-json.
- `--input-format stream-json` exists for realtime stdin input, not needed for v1.

## Stream shape

Successful stream:

- `system/init` includes `cwd`, `session_id`, `tools`, `model`, `permissionMode`,
  `apiKeySource`, and `claude_code_version`.
- `assistant` events carry message content blocks; text blocks contain assistant output.
- `result` includes `subtype`, `is_error`, `session_id`, `result`, `stop_reason`,
  `terminal_reason`, usage, and model usage.

Do not trust process exit code alone. Treat `result.is_error === true` as a driver failure even
when `result.subtype` is `"success"`.

## Model observations

- `--model haiku` succeeds and resolves to `claude-haiku-4-5-20251001`.
- `--model sonnet` succeeds and resolves to `claude-sonnet-4-6`.
- `--model fable` is accepted by argv parsing but returned an in-stream assistant error:
  `Claude Fable 5 is currently unavailable`; process exit code was `1`.

Caara core should keep the external model specifier opaque. Claude driver owns model validation and
failure policy.

## Resume and cwd

The reusable handle is the Claude Code `session_id` from `system/init` or `result`.

Same cwd resume works:

```bash
claude -p --verbose --output-format stream-json \
  --resume 2748e6be-2b1f-4c03-b069-d6d0c5783a0b \
  --model sonnet \
  --effort low \
  --max-budget-usd 0.05 \
  --tools "" \
  "Reply with exactly CAARA_RESUME_OK and nothing else."
```

Different cwd resume fails with `No conversation found with session ID: ...`.

Driver implication: session bindings must store cwd and run resumed turns from the same cwd that
created the Claude session.

## Cancellation

SIGINT during a print-mode stream produced:

- partial stream events with assistant text deltas;
- a `user` event containing `[Request interrupted by user]`;
- `result.subtype: "error_during_execution"`;
- `result.is_error: true`;
- `result.terminal_reason: "aborted_streaming"`.

A follow-up `--resume <same-session-id>` from the same cwd succeeded and returned
`CAARA_AFTER_CANCEL_OK`.

Driver policy:

- graceful interrupt with `terminal_reason=aborted_streaming` and successful same-cwd resume probe
  proves the session reusable;
- hard termination or unknown process loss is not proven reusable;
- wrong-cwd resume is not reusable and should enter session recovery.
