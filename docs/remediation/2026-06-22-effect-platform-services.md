# Effect Platform Services Remediation

Date: 2026-06-22

Scope: investigation only. This doc covers cleanup needed around Effect v4 services, `@effect/platform-bun`, direct host IO, and test layers. It does not propose retaining the current Claude CLI driver as a compatibility path.

## Executive Summary

The current implementation mixes Effect code with direct Bun, Node, and process globals. The biggest offenders are:

- `src/claudeCodeDriver/process.ts`: raw `Bun.spawn`, Bun process handles, and web-stream plumbing.
- `src/claudeCodeDriver/driver.ts`: raw `node:crypto` UUID generation and `process.env` captured by the live layer constructor.
- `src/mockResponsesProvider/sessionDirectory.ts`: raw `node:fs/promises`, `node:path`, `node:os`, `Bun.file`, and `process.env`, with the live state directory resolved at module load.
- `src/mockResponsesProvider/codexTurnContext.ts`: raw `node:path` for platform path validation.
- Test/policy harnesses: raw filesystem/process/env usage is widespread and currently tied to the fake Claude CLI architecture.

Effect v4 in this repo already depends on `@effect/platform-bun`, and its source exposes Bun layers for `FileSystem`, `Path`, `Crypto`, `ChildProcessSpawner`, `Stdio`, and `Terminal` via `BunServices.layer`. Use those at app/test edges instead of hand-wrapping host APIs.

Important reference conflict: the local `effect-ts` skill mentions `ServiceMap.Service`, but the project AGENTS file explicitly says to use `Context.Service`, and the checked Effect source here exposes `Context.Service` as the service key API. Prefer the project rule plus installed source. Do not migrate to `ServiceMap.Service` unless the dependency actually exposes and documents it in this repo.

## Findings

### Raw process spawning

`src/claudeCodeDriver/process.ts` currently owns the Claude process lifecycle:

- `ClaudeCodeChildProcess = ReturnType<typeof Bun.spawn>`
- `spawnClaudeCode` calls `Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" })`
- stdout/stderr are treated as Bun/web streams
- exit is checked via `childProcess.exited`
- cancellation in `src/claudeCodeDriver/driver.ts` calls `childProcess.kill("SIGINT")`

This should not survive the Claude SDK rewrite. If the SDK owns process spawning, Caara should depend on an SDK adapter/service, not on `ChildProcessSpawner` for Claude.

If a CLI-backed driver is still needed for another agent, use `effect/unstable/process`:

- `ChildProcess.make(command, args, { cwd, env, extendEnv, stdout, stderr, killSignal, forceKillAfter })`
- `ChildProcessSpawner.spawn/string/lines/streamLines`
- provide `@effect/platform-bun` `BunServices.layer`
- keep process lifetime scoped with `Effect.scoped` or explicit `Scope`

The manual `src/claudeCodeContract/runHarness.ts` also calls `Bun.spawn`. After SDK adoption, either delete that CLI-contract harness or move it to an explicit manual probe backed by `ChildProcessSpawner`.

### Raw filesystem/path/env

`src/mockResponsesProvider/sessionDirectory.ts` is the main platform-service cleanup target:

- `fs.readFile`, `fs.writeFile`, `fs.mkdir`, `fs.rm` should become `FileSystem.FileSystem` service calls.
- `Bun.file(filePath).exists()` should become `fs.exists(filePath)`.
- `path.join`, `path.dirname` should come from `Path.Path`.
- `process.env` and `os.homedir()` should be replaced by a config layer.
- `sessionDirectoryFromEnvironmentLive` currently resolves `stateDir` during module evaluation. Make this a `Layer.effect` so config errors happen during layer construction, not import.

Recommended state-dir config shape:

- read `CAARA_STATE_DIR` as the explicit override
- otherwise read `XDG_STATE_HOME` and append `caara`
- otherwise read `HOME` and append `.local/state/caara`
- if none exist, fail explicitly with a typed configuration/startup error

Avoid `os.homedir()` fallback if the app requires a durable state directory. This matches the project preference for explicit hard failures over silent fallback.

`src/mockResponsesProvider/codexTurnContext.ts` uses `path.isAbsolute` while already returning an Effect. Pull `Path.Path` inside `decodeCodexTurnRequest` or a path-aware helper and provide `BunServices.layer` in app/test layers.

### Raw env in Claude driver

`src/claudeCodeDriver/driver.ts` has:

- `ClaudeCodeAgentDriverConfig.env?: NodeJS.ProcessEnv`
- default `env = process.env`
- test layers pass copied `process.env` with fake variables

For the SDK rewrite, avoid exposing raw `NodeJS.ProcessEnv` as a domain-level driver config. Use one of:

- a `ClaudeCodeSdkClient` service whose live layer constructs the SDK client/query entrypoint
- a `ClaudeCodeDriverConfig` service loaded through `Config`
- specific named config values, not a whole env bag

If a future CLI driver needs env, keep that in a CLI adapter service and pass `ChildProcess` `env` plus `extendEnv` explicitly. Do not leak process env through the common agent-driver API.

### Raw randomness

`src/claudeCodeDriver/driver.ts` imports `randomUUID` from `node:crypto` for Caara-created session ids. Effect v4 has a `Crypto.Crypto` service with `randomUUIDv4`, and `BunServices.layer` provides it.

Use `Crypto.Crypto` in the live driver layer or a session-id generator service. Tests can then provide deterministic UUIDs without monkey-patching Node crypto.

### Time / Clock

No production `Date.now` or `new Date` usage was found. Current timeout usage is via Effect (`Effect.timeoutOption("1 second")`), which is compatible with Effect clocks.

Recommendations:

- keep all future time reads in `Clock`
- use `TestClock` for time-dependent tests
- if persisted bindings later gain timestamps, inject them via `Clock`, not JS `Date`

### Service interfaces and type-shape functions

The code uses `Context.Service` classes, which is consistent with project AGENTS and the Effect source checked in this repo. The problem is not `Context.Service`; the problem is fake exported "shape" effects used to infer method types:

- `agentDriverCancelShape`
- `agentDriverStartShape`
- `agentDriverResolveShape`
- `getSessionBindingEffectShape`
- `saveSessionBindingEffectShape`
- `deleteSessionBindingEffectShape`
- `turnConcurrencyAcquireShape`

These functions are runtime values pretending to be type declarations. They create fake behavior, pull in dummy domain values, and make service contracts harder to read.

Replace them with explicit type aliases, for example:

```ts
type AgentDriverStart = (
  turn: AgentDriverTurn,
) => Effect.Effect<AgentDriverTurnResult, AgentDriverError>;

type AgentDriverCancel = () => Effect.Effect<AgentCancellationOutcome>;

type SessionDirectoryGet = (
  key: SessionBindingKey,
) => Effect.Effect<Option.Option<CaaraSessionBinding>, SessionDirectoryError>;
```

Service methods should have `R = never`; dependencies belong in layer construction. This keeps the app graph visible at the composition root.

## ChildProcessSpawner Decision

If the Claude Code SDK owns the Claude process, `ChildProcessSpawner` is not needed in the Claude driver. The SDK adapter should expose SDK-native operations and event types.

`ChildProcessSpawner` is still useful for:

- future agent drivers that only expose a CLI
- manual/contract probes that intentionally execute a command
- runtime harnesses that start real subprocess fixtures
- smoke-test helpers that need scoped child-process cleanup

Do not introduce a Caara-owned `ChildProcessSpawner` wrapper only to call the Claude SDK. That would preserve the wrong seam.

## Recommended Target Shape

### App composition

`src/caara.ts` should provide platform services once:

- `BunServices.layer` for `FileSystem`, `Path`, `Crypto`, and any future process services
- `BunHttpServer.layer(...)` for HTTP server
- application services layered over config/platform services

Avoid live layers that capture host state as default arguments at import time.

### SessionDirectory

Make `sessionDirectoryLive` a `Layer.effect` that depends on:

- `FileSystem.FileSystem`
- `Path.Path`
- config service carrying `stateDir`

Keep pure helpers pure where possible:

- path segment encoding can stay pure
- schema encode/decode can stay pure/effectful without platform dependencies
- file path construction can either accept a `Path.Path` argument or live inside the service layer

### Claude SDK adapter

Create an SDK-facing service seam before fixing platform process code:

- live layer imports SDK types and SDK query/client creation
- tests inject a fake SDK client/query producer
- driver consumes SDK events and maps to Caara runtime events
- no `Bun.spawn`, no Claude stdout parser, no fake CLI executable in SDK adapter tests

After that, delete the current CLI process module and most CLI-argv tests. Do not keep a parallel compatibility path unless explicitly requested.

## Test-Layer Strategy

Use `@effect/vitest` `it.effect` for Effect tests, per `docs/agents/testing-patterns.md`.

Recommended test layers:

- `SessionDirectory` unit/integration tests: provide `BunServices.layer`, create a project-local scoped temp directory via `FileSystem.makeTempDirectoryScoped({ directory: temp.local/YYYY-MM-DD, prefix })`, and assert persisted JSON through the service.
- Pure path helpers: either test pure helpers directly or provide `Path` through `BunServices.layer`.
- Config tests: prefer `Layer.succeed` for config services. Use `ConfigProvider` only when testing config decoding itself.
- Crypto/session-id tests: inject deterministic UUID service or a `Crypto` test layer.
- SDK driver tests: fake SDK service that emits typed SDK events and records SDK input/options. Do not spawn a fake Claude executable for normal unit tests.
- CLI harness tests, if retained: isolate them as boundary simulator tests using `ChildProcessSpawner` and scoped temp directories.

The fake executable scripts embedded in tests may still use `process.argv`, `process.env`, and `process.cwd()` internally because they simulate an external process boundary. The harness that creates and runs them should use platform services.

## Implementation Order

1. Decide the Claude SDK seam first. Add SDK dependency/types and design the `ClaudeCodeSdkClient`/query service. This determines whether process code is deleted or merely moved to a CLI-only adapter.
2. Replace type-shape functions with explicit service method type aliases. This is low behavior risk and makes the rest of the refactor easier.
3. Add app config services for state dir and driver/SDK config. Make env reads happen through `Config` in layers.
4. Provide `BunServices.layer` at the app/test composition edge.
5. Refactor `SessionDirectory` to `FileSystem`/`Path`/config services.
6. Move `codexTurnContext` absolute-path validation to `Path.Path`.
7. Replace raw UUID generation with `Crypto.Crypto` or a small session-id generator service.
8. Delete/refactor Claude CLI process code after SDK tests cover start/resume/cancel/session behavior.
9. Convert remaining CLI/manual harnesses to `ChildProcessSpawner` only where they are intentionally process-bound.

## Risks

- Layer graph churn: moving host APIs into services will surface missing `R` requirements. Compose layers at the app/test edge instead of patching local `Effect.provide` calls.
- SDK semantics: cancellation, resume, session ids, and event ordering may not map 1:1 to the old CLI JSONL contract. Treat old CLI tests as disposable architecture tests, not preservation tests.
- Config behavior change: removing `os.homedir()` fallback can make startup fail in malformed environments. This is intended but needs clear error messages.
- Test artifacts: scoped temp dirs clean up by default. Runtime failure forensics may need retained fixture dirs for selected integration tests.
- Stale docs risk: the local skill docs mention `ServiceMap.Service`, but current project/source guidance points to `Context.Service`. Verify against installed `effect` before doing broad service syntax changes.
