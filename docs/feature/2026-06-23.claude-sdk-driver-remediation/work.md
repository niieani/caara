# Work Notes

## Source Of Truth

- fp PRD queue: CAARA-zoksjrdd -> CAARA-wkwdmzxd -> CAARA-nsldrqnt.
- Current PRD status: CAARA-zoksjrdd in progress.
- Known dependency issue: CAARA-cgjfrhwf depends on CAARA-uagzirfk from later PRD CAARA-wkwdmzxd.

## Completed Slice: CAARA-xedpqytc

Problem:

- `server.ts` catches runtime stream errors, logs `TurnFailed`, drains the failure, and lets the Responses encoder append `response.completed`.
- Finalizer sees stream success and persists a completed session binding.

Target:

- Runtime stream errors after turn start become `response.failed`, never `response.completed`.
- Finalizer releases in-flight ownership without completing the binding.
- Existing binding remains unchanged after failed follow-up.

Test seam:

- Provider integration tests with simulator driver runtime failures.
- Assert SSE events, relay logs, session binding file, and next-turn lease reuse.

## Current Slice: CAARA-yrrtiwje

Problem:

- Driver, session directory, and turn concurrency services exported fake Effect "shape" values to infer method types.
- Driver cancellation used a zero-argument function returning an Effect, creating unnecessary lazy indirection.

Target:

- Replace fake shape values with named service/driver contract types.
- Keep runtime event stream, terminal outcome, cancellation, start, resolve, session directory, and concurrency contracts explicit.
- Exercise driver registry through `Context.Service` injection in focused tests.

Test seam:

- `agentDriverContract.test.ts` resolves a driver via `AgentDriverRegistry`, starts it, consumes the runtime stream, runs cancellation, and checks typed runtime failure stream behavior.
