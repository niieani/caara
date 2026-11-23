# Delegation context is derived by Caara, not passed by callers

Portable blind delegation first protected against recursion with caller-supplied lineage:
`originMetadata` on the CLI, MCP, and HTTP surfaces, a comma-separated `caaraLineage` parsed by the
Codex driver, a Codex-only `CAARA_CODEX_MAXIMUM_DEPTH`, lineage stored in durable sessions, and
prompt instructions asking Codex to pass the lineage on. Any agent that forgot, reset, or rewrote
that metadata defeated the protection, and only Codex enforced it.

Caara now derives a **delegation context** for every Agent turn: the **immediate caller harness**
and the **delegation depth**. The legacy lineage path is removed with no compatibility layer.

- Caara injects `CAARA_HARNESS=<spawned harness>` and `CAARA_DELEGATION_DEPTH=<depth + 1>` into
  every harness it spawns (Claude Agent SDK query environment, `agy`, `codex exec`).
- Each boundary derives the caller, Caara's own marker first, then verified native host markers:
  the CLI and MCP adapters read their process environment (`CLAUDECODE=1` for Claude Code,
  `CODEX_THREAD_ID` for Codex shells) and forward the result as `x-caara-harness` /
  `x-caara-delegation-depth` headers; portable HTTP trusts only those headers, so a raw call is
  direct; Responses requests carry required Codex subagent identity headers, which verify Codex as
  the caller, and installed roles forward Caara's marker through `env_http_headers`.
- Malformed markers, several distinct native markers without a Caara marker, and a Responses
  `x-caara-harness` other than `codex` fail explicitly.
- The Agent Turn seam enforces the policy before session preparation and before any driver starts:
  only an immediate caller/target match is rejected, with that harness's native subagent
  alternative; a harness target is rejected once the incoming depth reaches the service's
  `delegation.maximumDepth` (default 3).
- The context is never stored; resumed sessions derive it on each turn.

Consequences:

- Repeated non-adjacent harnesses (Codex → Claude → Codex) are valid; depth alone bounds nesting.
- Native markers are inherited environment, so Caara's marker must win: a harness launched outside
  Caara beneath a Caara-spawned harness inherits that harness's `CAARA_HARNESS`. This is accepted;
  the depth bound still holds because depth is inherited too.
- Antigravity has no verified native marker. Installed Antigravity guidance prefixes
  `caara agent start` with `CAARA_HARNESS=agy`; Codex MCP configuration sets
  `CAARA_HARNESS=codex` and forwards `CAARA_DELEGATION_DEPTH` through `env_vars`. Claude Code
  launches MCP servers with `CLAUDECODE=1`, so it needs no configuration.
- Diagnostic targets spawn no harness and are never limited.
- The `x-caara-*` headers are unauthenticated request input on the portable and Responses routes.
  They can only restrict a turn, because their absence already yields the most permissive state
  (direct, depth 0). This does not fully meet the originating Task's "no HTTP caller/depth controls"
  requirement. Whether to replace them with a service-issued opaque delegation token, an
  adapter-only channel, or accept them as restrict-only markers is an open decision.
- Codex stdio MCP servers receive only an environment allowlist, so Codex MCP entries must set
  `CAARA_HARNESS` and forward `CAARA_DELEGATION_DEPTH`; Caara does not install that configuration.
