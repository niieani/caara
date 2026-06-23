# Claude SDK Driver Remediation

## Brief

Execute fp PRDs in order: CAARA-zoksjrdd, CAARA-wkwdmzxd, CAARA-nsldrqnt.

Current active PRD: CAARA-zoksjrdd. Goal: replace unsafe Claude CLI/stdout architecture with an SDK-backed driver architecture, preserving explicit Caara runtime/session boundaries.

## Scope

In scope:

- Fix runtime stream failure semantics before deeper driver work.
- Strengthen driver, runtime, session binding, Responses encoding, cancellation, permission, and smoke paths according to child issues.
- Keep each fp child issue atomic: red tests, implementation, validation, comment, commit, fp commit assignment.
- Use dependency order from fp as source of truth.

Out of scope:

- Interleaving later PRDs unless a dependency requires it and fp/user direction permits it.
- Preserving legacy Claude CLI production behavior once SDK path covers normal turns.
- Silent fallback paths for missing required driver/session state.

## Criteria And Verification

- Runtime stream failures cannot emit `response.completed`.
  Verifier: focused provider tests for failure before output and after partial output.
- Failed runtime streams log `TurnFailed`, release in-flight ownership, and do not complete or overwrite session bindings.
  Verifier: relay-log and persisted-binding assertions.
- Every child issue is completed only after `bun lint`, `bun run test --run`, and `bun run fmt`.
  Verifier: command output captured in issue comments.
- Final PRD completion requires independent implementation review with no unresolved blocking findings.
  Verifier: review summary in final PRD comment.

## Execution Shape

Sliced fp execution. One shared workdesk for all queued PRDs. Current slice: CAARA-xedpqytc, failure semantics.
