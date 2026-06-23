# Diagnostic Driver

## Brief

Implement fp PRD `CAARA-wkwdmzxd` as part of the open PRD queue. User authorized dependency-order
interleaving across `CAARA-zoksjrdd`, `CAARA-wkwdmzxd`, and `CAARA-nsldrqnt`; the Diagnostic driver
unblocks SDK activity commentary and later Antigravity work.

## Goal

Caara has an always-available first-class Diagnostic driver selected by `diagnostic/<scenario>`.
Diagnostic scenarios use normal driver registry, session binding, runtime event, Responses stream,
relay log, cancellation, and recovery paths. They replace the old undocumented simulator driver
test seam.

## Scope

In scope:

- Hardcoded typed Diagnostic scenarios with bounded driver-owned options.
- Provider-boundary tests for observable Responses, relay-log, and binding behavior.
- Migration away from `simulator_*` options and simulator driver naming.
- Scenario runbooks and smoke evidence as later child issues require.

Out of scope:

- Arbitrary scenario scripts, JSON event DSLs, uploaded scripts, or raw event passthrough.
- Claude SDK behavior simulation.
- Antigravity CLI implementation before `CAARA-zoksjrdd` and `CAARA-wkwdmzxd` are done.

## Criteria And Verification

- `diagnostic/basic` returns deterministic assistant output through normal runtime/Responses flow.
  Verifier: `diagnosticDriverBasic.test.ts`.
- Successful Diagnostic turns persist a durable opaque Diagnostic cursor and resume follow-up turns.
  Verifier: provider/session binding tests inspect persisted binding state.
- Diagnostic options are bounded and driver-owned; unsupported options/scenarios fail explicitly.
  Verifier: focused diagnostic option failure tests.
- Existing simulator coverage is migrated to Diagnostic scenario names.
  Verifier: stale `simulatorDriver` imports/options removed; provider runtime/cancel/recovery tests
  pass with Diagnostic driver.
- Each child issue gets red tests first, focused validation, full suite, lint, format, atomic commit,
  fp revision assignment, and fp completion comment.

## Execution

Dependency-order interleaving. Current slice: `CAARA-kbdhghin`, Diagnostic basic scenario and
simulator seam retirement.
