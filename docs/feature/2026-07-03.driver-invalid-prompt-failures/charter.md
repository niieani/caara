# Driver invalid-prompt failures

Brief: implement fp PRD `CAARA-cglrpxly` and child issues for Codex-visible Caara driver failures.

Goal: driver failures meant to guide the managing Codex agent surface through accepted SSE
`response.failed` frames with `error.code = "invalid_prompt"`. True internal or unexpected
operational failures use `server_error` only by explicit classification.

Subject:

- shared `AgentDriverError` contract and runtime response encoder
- Claude Agent SDK driver validation/startup/recovery paths
- Antigravity CLI driver validation/recovery paths
- pre-driver validation failures at Responses transport boundary
- docs and smoke runbooks

Principles:

- driver options are driver-owned; each driver validates and classifies its own prompt/options
- unsupported current-turn content fails explicitly
- lost-session recovery is only for external-session continuity loss, not invalid request/config
- no silent fallback for driver error classification

In scope:

- breaking cleanup of legacy omitted driver error codes
- focused red tests per child issue before implementation
- full `bun lint`, `bun run test --run`, `bun run fmt` before completing each child
- atomic commits and fp revision links per child
- independent PRD implementation review before marking parent done

Out of scope:

- changing Codex client behavior
- adding new driver option semantics unrelated to error classification
- manual external Claude/Antigravity smokes unless tests/docs require evidence only runnable locally

Criteria and verification:

- `CAARA-emrpolgn`: driver errors have explicit constructors/classification and encoder preserves
  driver-provided codes. Verify via runtime encoder tests and diagnostic invalid-request tests.
- `CAARA-lioqnzlx`: Claude option, prompt, TMPDIR/permission, and expected startup failures emit
  `invalid_prompt` with exact messages. Verify focused Claude tests plus provider path tests.
- `CAARA-cvvwwjqu`: recovery bypasses `invalid_prompt` driver failures. Verify resumed invalid
  option tests for Claude and Antigravity and no recovery assistant text.
- `CAARA-tlyjkhtm`: Antigravity prompt/option validation failures emit `invalid_prompt`. Verify
  option parser, prompt parser, and provider path tests.
- `CAARA-izqiluwf`: pre-driver validation failures use documented Codex-readable nonretryable
  transport behavior, not HTTP `server_error`. Verify regression tests.
- `CAARA-ytjzxyeh`: docs and smoke runbooks describe `invalid_prompt` vs `server_error`. Verify
  doc review and focused test references.

Execution: sliced fp child issue loop. One workdesk for all slices. Each child completion requires
full validation, fp completion comment, status update, atomic commit, and commit assignment.
