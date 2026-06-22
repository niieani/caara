# Testing Patterns

Best practices for writing and diagnosing tests in Effect v4 TypeScript projects.

## Framework Selection

Use `it.effect` for Effect-valued tests. Use `assert` from `@effect/vitest`; keep Vitest `expect`
out of ordinary Effect tests.

```typescript
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

it.effect("runs the workflow", () =>
  Effect.gen(function* () {
    const result = yield* workflow(input);
    assert.deepStrictEqual(result, expected);
  }),
);
```

Use regular `it` for pure TypeScript functions that do not return Effects.

```typescript
import { assert, describe, it } from "@effect/vitest";

it("parses the input", () => {
  const result = parseInput(input);
  assert.strictEqual(result.kind, "valid");
});
```

Use project-owned test APIs for service-process/runtime integration tests when they exist. Keep
those APIs Effect-aware so tests retain scoped cleanup, `TestClock`, `TestConsole`, layers, and
fiber diagnostics.

## Effect Test Rules

- Never use `Effect.runSync` in tests.
- Do not use `expect` inside `it.effect`; use `assert` methods.
- Use `TestClock` for time-dependent Effect code.
- Provide fresh layers per test unless a suite explicitly owns a shared expensive resource.
- Use `it.layer` only for deliberate shared suite resources.
- Do not scatter `Effect.provide` through assertions; build clear test layers or harness helpers.
- Keep resource lifetimes scoped with `Effect.scoped`, `Layer.scoped`, or fixture APIs.
- Pass Effect-valued conditions to Effect control-flow helpers. Wrap booleans with
  `Effect.succeed(...)` where required.
- Group related tests with `describe`.

## Test Types

### Unit Tests

Use unit tests for pure parsing, schema validation, deterministic domain logic, storage helpers, and
narrow service methods with explicit test layers.

Unit tests should not start external processes, open network listeners, or mutate shared process
state.

### Integration Tests

Use integration tests for behavior that crosses service boundaries, persistence, HTTP/RPC/MCP
protocols, files, Git, process lifecycle, queues, reload, shutdown, recovery, or ordering.

Prefer exercising the real outer contract over replacing internal modules. Internal mocks are
acceptable for focused unit tests only.

### Boundary Simulator Tests

Use boundary simulator tests for simulator/control-plane behavior itself: request capture,
responder behavior, protocol validation, malformed frames, process lifecycle, and artifact handling.

Prefer concurrent simulator tests only when each test owns its simulator instance, run directory,
ports, sockets, and mutable state.

### Timer-Contract Tests

Only timer-contract tests may depend on real elapsed time. Keep them small, name them clearly, and
document the timer contract being tested.

## Runtime Harness Shape

For runtime behavior, prefer an outer-seam harness:

- boundary simulator process for each external protocol;
- isolated runtime fixture directory;
- real service entrypoint process;
- assertions through simulator traffic, protocol calls, persisted state, files, process exit, and
  structured logs.

Do not replace internal modules when the contract depends on app-facing protocols, durable state,
process lifecycle, external IO ordering, or restart recovery.

Fixtures should allocate HTTP ports through the OS allocator, not by random guessing. If tests need
database state after async work, assert through a causal durable wait before reading final
snapshots.

## Synchronization

Tests should wait on causal observations, not arbitrary time.

Prefer:

- live process output observers owned by harnesses;
- simulator `takeRequest` or equivalent request queues;
- simulator responses;
- returned protocol responses;
- observed process exit;
- observed structured log events;
- deterministic worker drain seams;
- one durable read after a known causal boundary.

Avoid:

- polling process log files for readiness;
- raw `Effect.sleep`;
- raw `setTimeout`;
- retry loops around ordinary assertions;
- "sleep then inspect request history";
- waiting for default worker poll intervals.

If a test still needs polling because no causal seam exists, treat that as a harness gap. Add or
plan the missing seam instead of normalizing polling.

When high-speed workers make observations race ahead of assertions, assert durable contracts and
required observations with presence/unordered checks unless ordering or exact counts are the
behavior under test.

## Negative Assertions

Do not assert "nothing happened" by sleeping and inspecting history.

Use a bounded helper owned by the simulator or harness, for example:

- `expectNoRequest({ method })`;
- `expectNoRequestMatching({ predicate })`;
- `expectNoLogEvent({ event })`;
- `expectNoProcessExit()`.

The timeout belongs inside the helper, not scattered across tests. Raw `Effect.sleep` is only
acceptable in tests for real timer/process contracts, such as graceful shutdown windows or process
termination probes. Add a local comment when that intent is not obvious.

## Failure Forensics

Runtime harness failures should retain artifacts under a temp directory. Use retained artifacts
before rerunning a flaky test; they often contain the exact request, log line, or persisted row that
explains the failure.

Useful retained files usually include:

- request journals for each boundary simulator;
- control-plane traffic and hygiene assertions;
- child process stdout/stderr logs;
- structured service logs;
- fixture-local databases or persisted state;
- run directories and generated files.

Runtime flake checklist:

1. Start from the artifact path printed by the failed test.
2. If simulator hygiene reports pending requests, inspect the matching request journal first.
3. Read control-plane traffic around the failing cleanup/assert-clean call.
4. Inspect structured logs and persisted state before rerunning.
5. If a full-suite failure passes in isolation, compare failed full-suite artifacts with focused
   successful artifacts. Look for worker passes, shutdown passes, retries, and extra external
   requests that only happen under suite timing.

Treat a slow or flaky profile as an investigation queue, not a reason to raise timeouts. Fix the
implementation or test synchronization root cause.
