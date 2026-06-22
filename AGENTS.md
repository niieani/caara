This project ("caarra") an OpenAI-compatible Responses API wrapper for other code agents (Claude Code, Antigravity) designed to enable spawning those agents as Codex's subagents.

Context on project + vocabulary in: `./CONTEXT.md`
Decisions in `./docs/adr/`
The spec in `./docs/runtime.md`

Lint: `bun lint` (biome + oxlint)
Format: `bun fmt` (oxfmt)

Stack: Bun + TypeScript + Vitest + Effect TS (v4, latest beta)

Use Bun instead of Node.js for both engine and package manager.
Run Bun scripts as `bun run <script> <args>`; do not insert `--` before script args.
Never run `bun test`, always run `bun run test <vitest filters/options>` for testing (vitest, not bun's built-in test runner).
Bun automatically loads .env, so don't use dotenv.

To quickly eval some code, run a command like:

```bash
FOO="$foo" bun run - <<'BUN'
console.log("hello", process.env.FOO);
BUN
```

## References

AVOID making assumptions about APIs. Whenever working with a library, ALWAYS consult:

- `node_modules/bun-types/docs/**.mdx` - Bun engine, API and PM
- `references/effect/*` - Effect library and docs
- `references/vitest/docs/{guide,api}/*` - docs and reference for Vitest
- Do not assume CLI flags/args; verify with `--help` or run the command.

# Effect v4

Full source code and docs available in `references/effect/*`. Review patterns from there to understand how to write Effect v4 code.

v4 has some differences from the previous major versions:

Functionality that was spread across `@effect/platform`, `@effect/rpc`, `@effect/cluster`, and others now lives directly inside `effect`

Packages that remain separate are platform-specific, provider-specific, or technology-specific implementations:

- `@effect/platform-*` — platform packages
- `@effect/sql-*` — SQL driver packages
- `@effect/ai-*` — AI provider packages
- `@effect/opentelemetry` — OpenTelemetry integration
- `@effect/atom-*` — framework-specific atom bindings
- `@effect/vitest` — Vitest testing utilities

Effect AI MCP no-arg tools exposed to Codex/OpenAI need raw JSON Schema parameters:
`{ type: "object", properties: {}, additionalProperties: false }`. `Schema.Struct({})` advertises
an object-or-array union, and `Tool.EmptyParams` omits explicit `properties`.

## Prefer `Effect.fnUntraced` over functions that return `Effect.gen`

Instead of writing:

```ts
const fn = (param: string) =>
  Effect.gen(function*() {
    // ...
  })
```

Prefer:

```ts
const fn = Effect.fnUntraced(function*(param: string) {
  // ...
})
```

## Using `Context.Service`

Prefer the class syntax when working with `Context.Service`. For example:

```ts
import { Context } from "effect"

class MyService extends Context.Service<MyService, {
  readonly doSomething: (input: string) => number
}>()("MyService") {}
```

## Never use async / await or try / catch

Instead use `Effect` apis like `Effect.fnUntraced`, `Effect.gen`,
`Effect.tryPromise` etc.

Look at existing code in the repository to learn and follow established patterns

## Never use Date.now or new Date

Instead use the `Clock` module, and `TestClock` for adjusting time in tests.

## Effect Library Development Patterns

### NEVER: try-catch in Effect.gen

**REASON**: Effect generators handle errors through the Effect type system, not JavaScript exceptions.

```typescript
// ❌ WRONG - This will cause runtime errors
Effect.gen(function*() {
  try {
    const result = yield* someEffect
    return result
  } catch (error) {
    // This will never be reached and breaks Effect semantics
    console.error(error)
  }
})

// ✅ CORRECT - Use Effect's built-in error handling
Effect.gen(function*() {
  const result = yield* Effect.result(someEffect)
  if (result._tag === "Failure") {
    // Handle error case properly
    console.error("Effect failed:", result.cause)
    return yield* Effect.fail("Handled error")
  }
  return result.value
})
```

### return yield* Pattern for Errors

**CRITICAL**: Always use `return yield*` when yielding terminal effects.

```typescript
// ✅ CORRECT - Makes termination explicit
Effect.gen(function*() {
  if (invalidCondition) {
    return yield* Effect.fail("Validation failed")
  }

  if (shouldInterrupt) {
    return yield* Effect.interrupt
  }

  // Continue with normal flow
  const result = yield* someOtherEffect
  return result
})

// ❌ WRONG - Missing return keyword leads to unreachable code
Effect.gen(function*() {
  if (invalidCondition) {
    yield* Effect.fail("Validation failed") // Missing return!
    // Unreachable code after error!
  }
})
```

#### When to Use What

**Use `Effect.gen`** when:

- Writing inline effect composition
- One-off operations that don't need to be reused
- Inside other functions already being traced

**Use `Effect.fnUntraced`** when:

- Building library implementations
- Performance is critical (hot paths)
- Function is called many times per operation
- Tracing overhead is unacceptable

## Validation and testing

Test files: `*.test.ts`; no `__tests__` directories. Type tests: `*.tst.ts`.
When creating/fixing tests, run individual files instead of the whole project.

Create and use the `src/__experiments__/` subdirectory under any of the packages for throwaway code, and prototyping. Bravely create throwaway code and tests to explore, troubleshoot, understand how to use a library or API. They're ignored by git and linters.

Treat typecheck suggestions TS377* as blocking and resolve any issues before finishing.

### Testing patterns

Read docs/agents/testing-patterns.md before writing or modifying tests; it is authoritative.
Runtime lane = service-process integration tests under `src/runtime`, split into concurrent and serial Vitest projects. Non-runtime lane = in-process unit/integration tests outside `src/runtime`.

### Type level tests

Use the `tstyche` testing library when writing type tests.
You can run them with `bun run test:types <filename>`.

Use existing project `.tst.ts` files first; use `references/effect` examples only when project examples are insufficient.

## Code Style Guidelines

Implement using a maximally decoupled, DI/component/plugin-based architecture whenever possible.
Performance is key! Avoid workarounds, do things the right way, not the quick way.
Code should be clean, readable, and maintainable. Prioritize clarity over cleverness.
Each symbol (incl. `const`, `function`, `class`) should be annotated with TSDoc with a detailed description of what it does and what it is for. Don't repeat types in TSDoc, they are already present in the code.

TypeScript:

- strict mode
- If a type exists, use it. NEVER use `any`, or cast to `any`, for external/unverified inputs use `unknown`, and use an Effect `Schema` to validate them to a strict type
- use `import type` or `import { type X }` whenever possible (`verbatimModuleSyntax: true`)
- never use dynamic imports (`await import(...)`), unless asked to
- prefer `satisfies ...` and `as const` where possible, avoid casting using `as`
- prefer immutable/readonly types

Code:

- Do not add extra defensive checks or try/catch blocks
- Files or folders whose names contain `.gen` are generated artifacts. Never edit them manually; update the generator or source inputs and regenerate them.
- Node Builtins: use the `node:` prefix when importing, e.g. `node:fs` instead of `fs`.
- Prefer nullish coalescing `??` operator instead of `||` when applicable
- Prefer `undefined` over `null` if valid
- Use `??=` operator when appropriate
- When writing functions, prefer a single destructured object as the only argument (`fn({opt1, opt2})`). In some cases `fn(requiredArgument, {opt1, opt2})` signature is acceptable. Do _NOT_ create functions with >3 arguments, unless absolutely necessary.
- Use latest ECMAScript 2026 features (esnext) including all stage 4 TC39 proposal up to 2025, like `Symbol.dispose`, `using`, etc.
- Do not create barrel files, or files that re-export everything from a module.
- Constructors should be synchronous and never start any async operations; use methods if async initialization is required
- Naming: camelCase for variables/functions/filenames, PascalCase for classes/types

## Handoff

If committing, run `bun run fmt` prior.

## Agent skills

### Issue tracker

Issues are tracked in `fp`. See `docs/agents/issue-tracker.md`.

Brainstorms and other fp features:
@FP_AGENTS.md

### Triage labels

Triage roles use the default label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: read root `CONTEXT.md` and root `docs/adr/` when present. See `docs/agents/domain.md`.
