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

- Interleaving later PRDs except for the user-authorized dependency-order execution across
  `CAARA-zoksjrdd`, `CAARA-wkwdmzxd`, and `CAARA-nsldrqnt`.
- Preserving legacy Claude CLI production behavior once SDK path covers normal turns.
- Silent fallback paths for missing required driver/session state.

## Criteria And Verification

- Runtime stream failures cannot emit `response.completed`.
  Verifier: focused provider tests for failure before output and after partial output.
- Failed runtime streams log `TurnFailed`, release in-flight ownership, and do not complete or overwrite session bindings.
  Verifier: relay-log and persisted-binding assertions.
- SDK-backed cancellation interrupts, drains to terminal SDK result with a bound, and keeps bindings reusable only for clean aborted terminal reasons.
  Verifier: focused SDK cancellation tests before first event, after partial output, follow-up abort, ambiguous end, interrupt failure, and stream failure.
- Claude SDK driver runs non-interactively, reserves `AskUserQuestion`, and relays SDK permission denials as observable runtime context.
  Verifier: focused permission-policy tests for SDK query options, reserved-tool validation, runtime event mapping, and relay logging.
- Production Claude execution has no bespoke CLI transport, argv builder, stdout JSONL parser, or handwritten SDK-equivalent message union.
  Verifier: architecture regression test plus SDK driver focused tests.
- Active provider host IO for session persistence and path validation is supplied through Effect platform services or narrow config seams.
  Verifier: focused tests inject `FileSystem`/`Path`, assert env config failure, and cover existing provider/session harnesses with Bun platform layers.
- Current-turn Responses text, images, and workspace-file references map into SDK user-message prompt content; prior assistant/tool history and unsupported opaque content do not.
  Verifier: focused SDK prompt tests and SDK driver request assertions.
- Every child issue is completed only after `bun lint`, `bun run test --run`, and `bun run fmt`.
  Verifier: command output captured in issue comments.
- Final PRD completion requires independent implementation review with no unresolved blocking findings.
  Verifier: review summary in final PRD comment.

## Execution Shape

Sliced fp execution. One shared workdesk for all queued PRDs. Current dependency-interleaved slice:
`CAARA-kbdhghin`, Diagnostic basic scenario and simulator seam retirement.
