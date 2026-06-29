# caara

Caara lets Codex spawn external code agents as subagents through an OpenAI Responses-compatible
transport.

Codex sends a streaming `POST /v1/responses` request to Caara. Caara resolves the requested
`model` string, starts or resumes the matching external driver, and relays normalized runtime events
back to Codex as Responses SSE frames.

Deeper protocol and design details live in [docs/caara.md](docs/caara.md).

## What Works

Current drivers:

| Model prefix   | Driver                | Purpose                                     |
| -------------- | --------------------- | ------------------------------------------- |
| `claude/*`     | Claude Agent SDK      | Run Claude Code as a Codex subagent.        |
| `agy/*`        | Antigravity CLI       | Run Antigravity as a Codex subagent.        |
| `diagnostic/*` | In-process Diagnostic | Smoke-test Caara without an external agent. |

Current Caara behavior:

- validates Codex turn identity and workspace metadata before driver dispatch
- supports only streaming `POST /v1/responses`
- selects drivers from `model = "<external-agent-kind>/<external-model>"`
- persists session bindings per external agent kind and Codex thread id
- resumes follow-up turns with driver-owned resume cursors
- normalizes current-turn input before driver dispatch
- streams assistant text, reasoning summaries, and activity commentary back to Codex
- cancels in-flight driver work when Codex disconnects
- fails explicitly for malformed requests, invalid options, unsupported content, and unknown drivers

## Install

```bash
bun install
```

## Run

Start the local Responses-compatible bridge on `127.0.0.1:8787`:

```bash
bun run start
```

Caara serves:

- `POST /v1/responses`
- `stream: true` only
- Responses SSE output only

## Request Contract

Codex normally builds the request. For direct tests, the important fields are:

```json
{
  "model": "claude/haiku",
  "input": "Summarize this repository.",
  "stream": true
}
```

The model prefix selects the driver. The model suffix is driver-owned:

```text
claude/haiku
claude/sonnet
agy/gemini-3.5-flash
diagnostic/basic
```

Provider query parameters become driver options. Caara rejects duplicate query keys before driver
dispatch, and each driver rejects unknown option names.

## Claude Driver

`claude/*` targets route to the Claude Agent SDK driver.

The driver starts SDK `query()` with a durable Caara-generated session id on the first turn. On
follow-up turns it passes the stored Claude SDK resume cursor back to the SDK.

Supported provider query params:

| Query param                | Values / shape                                      |
| -------------------------- | --------------------------------------------------- |
| `effort`                   | `low`, `medium`, `high`, `xhigh`, `max`             |
| `max_budget_usd`           | positive number                                     |
| `tools`                    | `default`, `disabled`, or comma-delimited tool list |
| `allowed_tools`            | comma-delimited tool list                           |
| `disallowed_tools`         | comma-delimited tool list                           |
| `include_partial_messages` | `true` or `false`; defaults to `true`               |
| `permission_mode`          | `auto`, `dontAsk`, `bypassPermissions`              |
| `activity`                 | `on` or `off`; defaults to `on`                     |

`permission_mode` defaults to `dontAsk`. Caara intentionally rejects interactive Claude permission
modes because Codex subagent turns do not have an approval loop. `bypassPermissions` also sets the
SDK's required dangerous-bypass opt-in.

`AskUserQuestion` is always reserved for unsupported interactive questions. Attempts to allow it via
`tools` or `allowed_tools` fail explicitly; it is always included in `disallowedTools`.

Claude activity events become commentary messages by default. Use `activity=off` to keep activity in
relay logs while hiding it from the Codex-visible stream.

Example Codex provider config:

```toml
[model_providers.caara]
name = "Caara Responses"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
query_params = { effort = "high", permission_mode = "auto" }
```

## Antigravity Driver

`agy/*` targets route to the Antigravity CLI driver.

The driver runs `agy` with a normalized prompt, model, sandbox settings, optional extra directories,
and a JSONL transcript log. Follow-up turns pass the stored Antigravity conversation id when one is
available.

Supported provider query params:

| Query param                    | Values / shape                                  |
| ------------------------------ | ----------------------------------------------- |
| `model`                        | non-empty model override                        |
| `print_timeout_seconds`        | integer from `1` to `86400`; defaults to `7200` |
| `sandbox`                      | `true` or `false`; defaults from Codex sandbox  |
| `dangerously_skip_permissions` | `true` or `false`; requires trusted host config |
| `add_dirs`                     | JSON array of non-empty absolute paths          |
| `log_file`                     | absolute path                                   |
| `reasoning`                    | `on` or `off`; defaults to `on`                 |
| `activity`                     | `on` or `off`; defaults to `on`                 |

`reasoning=off` hides Antigravity thinking output from the Codex reasoning stream. `activity=off`
keeps command/activity lifecycle in relay logs while hiding Codex-visible commentary.

Caara always passes `--print-timeout` to `agy`. When `print_timeout_seconds` is omitted, Caara uses
`7200` seconds instead of the `agy` CLI's own `5m0s` default.

`dangerously_skip_permissions=true` is rejected unless the local Antigravity driver settings allow
dangerous permission skipping.

## Diagnostic Driver

`diagnostic/*` targets run inside Caara and do not invoke an external agent. Use them for smoke tests,
transport checks, recovery checks, and cancellation checks.

Supported scenarios:

- `diagnostic/basic`
- `diagnostic/reasoning`
- `diagnostic/activity`
- `diagnostic/fails-before-output`
- `diagnostic/fails-after-partial`
- `diagnostic/hangs-until-cancel`
- `diagnostic/recovery`
- `diagnostic/echo`

Useful query params:

| Query param              | Purpose                                |
| ------------------------ | -------------------------------------- |
| `diagnostic_answer_text` | custom deterministic answer text       |
| `diagnostic_chunk_count` | split deterministic output into chunks |
| `diagnostic_delay_ms`    | add bounded artificial delay           |
| `diagnostic_cancel`      | tune cancellation scenario             |
| `diagnostic_resume`      | tune resume behavior                   |
| `diagnostic_fresh_start` | force recovery fresh-start behavior    |
| `diagnostic_activity`    | `on` or `off` activity visibility      |

## Codex Agent Roles

Local Codex subagent configs live in `.codex/agents/caara-claude.toml` and
`.codex/agents/caara-antigravity.toml`.

| File                                   | `agent_type`        | Model                  |
| -------------------------------------- | ------------------- | ---------------------- |
| `.codex/agents/caara-claude.toml`      | `caara-claude`      | `claude/haiku`         |
| `.codex/agents/caara-antigravity.toml` | `caara-antigravity` | `agy/gemini-3.5-flash` |

Each role embeds its own `[model_providers.caara]` block because Codex validates custom agent role
config layers before merging project-level provider config.

Manual Codex smoke flow: [docs/agents/smoke-testing.md](docs/agents/smoke-testing.md).

## Sessions And State

Caara stores durable session bindings outside the repository. Bindings contain resume metadata only;
external agents remain the source of truth for their own conversation context.

State directory resolution:

1. `CAARA_STATE_DIR`
2. `$XDG_STATE_HOME/caara`
3. `$HOME/.local/state/caara`

Session bindings are keyed by external agent kind and Codex thread id. Changing requested model or
driver query options on an existing thread is treated as desired state for that driver, not a new
Caara session identity.

## Development

Format, lint, typecheck, and focused tests:

```bash
bun run fmt
bun run lint
bun run typecheck
bun run test src/claudeAgentSdkDriver/claudeAgentSdkPermissionPolicy.test.ts
```

Project test conventions:

- use Bun as package manager and runtime
- run Vitest through `bun run test <filters/options>`
- do not use Bun's built-in test runner for this project
- test files use `*.test.ts`; type tests use `*.tst.ts`

Before writing or changing tests, read
[docs/agents/testing-patterns.md](docs/agents/testing-patterns.md).
