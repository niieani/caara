# Driver invalid-prompt failure plan

## Current shape

- `AgentDriverError` currently allows missing `responseErrorCode`; encoder falls back to
  `server_error`.
- Diagnostic invalid-request already proves Codex understands `invalid_prompt`.
- Claude and Antigravity validation helpers mostly create bare `AgentDriverError`.
- Recovery paths treat all start failures similarly; they need to distinguish fatal surfaced
  driver errors from lost-session continuity failures.
- Original server pre-driver catches converted `AgentDriverError` to HTTP `server_error`;
  unsupported external agent kind and current-turn normalization now stream accepted SSE
  `response.failed` with `invalid_prompt`.

## Design

- Make driver error classification explicit through named builders:
  - surfaced driver/request failures: `invalid_prompt`
  - internal/unexpected driver failures: `server_error`
- Keep `AgentDriverError` serializable, but remove silent construction without a code.
- Centralize response-code selection so runtime encoder preserves driver codes and only fallback
  terminal transport gaps use `server_error`.
- Update driver-local validation helpers to use surfaced invalid-prompt builder.
- Recovery bypass rule: `invalid_prompt` is terminal and cannot become recovery text.
- Pre-driver split:
  - malformed/unaccepted transport input may return HTTP 400 OpenAI invalid request
  - accepted driver-bound failures stream `response.failed` with `invalid_prompt`

## Slice order

1. `CAARA-emrpolgn` shared contract and encoder.
2. `CAARA-lioqnzlx` Claude driver classification.
3. `CAARA-cvvwwjqu` recovery bypass.
4. `CAARA-tlyjkhtm` Antigravity validation classification.
5. `CAARA-izqiluwf` pre-driver validation transport behavior.
6. `CAARA-ytjzxyeh` docs and smoke runbooks.

## Validation

- Focused tests while implementing each slice.
- Required child gate: `bun lint`; `bun run test --run`; `bun run fmt`.
- Final PRD review by independent subagent before parent closeout.
