<div align="center">
  <img src="site/public/favicon.svg" alt="caara" width="88" />

# caara

**Run Claude Code and Antigravity as native Codex subagents.**

Agents, relayed: one local bridge, every model you subscribe to.

[Website](https://niieani.github.io/caara/) · [Quickstart](#quickstart) ·
[Spec](docs/caara.md) · [MIT License](LICENSE)

</div>

---

Caara is a local-first bridge that lets [Codex](https://openai.com/codex/) spawn external code
agents (Claude Code, Antigravity) as first-class subagents. Codex sends its normal streaming
`POST /v1/responses` request. Caara resolves the `model` string to a driver, starts or resumes the
real agent behind it, and relays text, reasoning, and activity back as Responses SSE frames. To
Codex, `claude/fable` is just another model.

## Why

- **Panels of models outscore any model alone.** OpenRouter's
  [Fusion benchmark](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) ran 100
  deep-research tasks: a Fable 5 + GPT-5.5 panel scored 69.0% where solo Fable 5 scored 65.3%, and
  a budget trio beat solo GPT-5.5 and Opus 4.8 at half the cost. Caara turns your Codex session
  into that orchestrator.
- **Each model does what it handles best.** Claude for frontend and judgment-heavy work, GPT-5.5
  for execution and orchestration, Gemini or a mixed panel for breadth-first code review.
- **A second model checks the diff.** Cross-family review catches what self-review keeps missing.
- **Fable where it counts.** Route the hard parts to Claude Fable and let cheaper seats handle
  execution, which costs less than Fable doing everything itself.
- **Every subscription, used to the max.** Your Claude and Antigravity plans carry subsidized
  usage that idles while you work in Codex. Spawning those agents as Codex subagents spends it
  without switching harnesses, and adds no API keys or per-token bills.
- **Local, open, and explicit.** MIT licensed, served on `127.0.0.1`, with loud typed failures
  instead of silent fallbacks.

## Quickstart

```bash
brew install --cask niieani/tap/caara
```

The cask installs the signed `caara` binary, sets up a per-user service on `127.0.0.1:8787`, runs
`doctor --fix`, health-checks it, and generates **Codex agent roles** for every driver it finds on
your machine (`claude`, `agy`):

```bash
ls ~/.codex/agents/caara-*.toml
# caara-claude-fable, caara-claude-sonnet, caara-agy-gemini-3-5-flash, ...
```

Then, inside Codex:

```text
> spawn a caara-claude-fable subagent to redesign the settings page
> use the panel skill: cross-review my last diff
```

Follow-up turns resume the same external agent session. Linux tarballs (and the macOS one) are on
[GitHub Releases](https://github.com/niieani/caara/releases).

Uninstall keeps your config, state, and logs; zap removes them too:

```bash
brew uninstall --cask caara          # stop + remove service, keep data
brew uninstall --cask --zap caara    # intentional full cleanup
```

## The Panel skill

Caara ships a repo-level Codex skill pack. **Panel** (`.agents/skills/panel/`) convenes a
cross-model panel of Caara-backed subagents plus the native Codex seat, then adjudicates:

| Strategy         | Use it when                       | Shape                                                                          |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| **Ensemble**     | one model would miss things       | isolated panelists attempt the task in parallel; a synthesis seat consolidates |
| **Debate**       | the direction itself is contested | panelists argue across rounds; dissent stays on the record                     |
| **Cross-review** | the work already exists           | one panelist works, a different model family reviews                           |

The skill is engineered against sycophantic convergence: the orchestrator verifies panelist
artifacts mechanically instead of reading them, forwards positions as artifact paths rather than
paraphrase, quarantines per-seat run directories from git and search, and applies a stall test
instead of a round cap. The Caara service itself stays unaware of the skill pack.

## How it works

```text
Codex ──POST /v1/responses (SSE)──▶ caara ──▶ Claude Agent SDK   (claude/*)
                                         ├──▶ Antigravity CLI    (agy/*)
                                         └──▶ Diagnostic driver  (diagnostic/*)
```

The model prefix selects the driver; the suffix belongs to the driver:

```text
claude/fable
claude/haiku
claude/sonnet
agy/gemini-3.5-flash
diagnostic/basic
```

For each valid streaming turn, Caara:

- validates Codex turn identity and workspace metadata before driver dispatch
- starts or resumes the external agent's own session (durable session bindings per external agent
  kind and Codex thread id, with driver-owned resume cursors)
- streams assistant text, reasoning summaries, and activity commentary back to Codex
- cancels in-flight driver work when Codex disconnects
- fails explicitly for malformed requests, invalid options, unsupported content, and unknown drivers

Caara serves `POST /v1/responses` (streaming only, Responses SSE output) and a shallow
`GET /health`. Full protocol and design details: [docs/caara.md](docs/caara.md).

### Codex provider config

Installed roles embed this for you; for manual setups:

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

Provider query parameters become driver options. Caara rejects duplicate query keys, and each
driver rejects unknown option names.

## Drivers

### Claude (`claude/*`)

Runs Claude Code through the Claude Agent SDK. Model suffixes pass through as-is: `claude/fable`
selects Claude Code's Fable alias; `claude/claude-fable-5` selects the full API model name when the
configured provider supports it. Fable requires Claude Code `v2.1.170+` and is unavailable to
zero-data-retention organizations.

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

`permission_mode` defaults to `dontAsk`. Interactive permission modes are rejected because Codex
subagent turns have no approval loop. `bypassPermissions` additionally requires the server to run
with `--allow-dangerous-skip-permissions`. `AskUserQuestion` is always disallowed. Claude activity
events stream as commentary by default; `activity=off` keeps them in relay logs only.

### Antigravity (`agy/*`)

Runs the `agy` CLI with a normalized prompt, model, sandbox settings, optional extra directories,
and a JSONL transcript log. Follow-up turns pass the stored Antigravity conversation id.

| Query param                    | Values / shape                                    |
| ------------------------------ | ------------------------------------------------- |
| `model`                        | non-empty model override                          |
| `print_timeout_seconds`        | integer from `1` to `86400`; defaults to `7200`   |
| `sandbox`                      | `true` or `false`; defaults from Codex sandbox    |
| `dangerously_skip_permissions` | `true` or `false`; requires server dangerous gate |
| `add_dirs`                     | JSON array of non-empty absolute paths            |
| `log_file`                     | absolute path                                     |
| `effort`                       | `low`, `medium`, `high`, or `xhigh`               |
| `reasoning`                    | `on` or `off`; defaults to `on`                   |
| `activity`                     | `on` or `off`; defaults to `on`                   |

Known Antigravity model-family slugs map Codex advisory effort to Antigravity display names
(`gemini-3.5-flash` maps low/medium/high exactly and xhigh to High; `gemini-3.1-pro` maps low to
Low and everything else to High; `gpt-oss-120b` maps to Medium; Claude Sonnet/Opus 4.6 map to
Thinking). Unknown model specifiers pass through unchanged.

### Diagnostic (`diagnostic/*`)

In-process scenarios for smoke-testing Caara without an external agent: `basic`, `reasoning`,
`activity`, `fails-before-output`, `fails-after-partial`, `hangs-until-cancel`, `recovery`, `echo`.
Tune them with `diagnostic_answer_text`, `diagnostic_chunk_count`, `diagnostic_delay_ms`,
`diagnostic_cancel`, `diagnostic_resume`, `diagnostic_fresh_start`, and `diagnostic_activity`.

## Operating the service

```bash
caara status                     # service + health overview
caara doctor [--fix]             # diagnose (and repair) the installation
caara install-service            # install binary + service + Codex roles, verify health
caara uninstall-service [--purge]
caara install-codex-roles [target-dir]
caara uninstall-codex-roles [target-dir]
```

`install-service` copies the compiled executable to `${XDG_BIN_HOME:-$HOME/.local/bin}/caara`,
writes the service config and launchd/systemd user unit, runs `doctor --fix`, installs Codex roles
for available drivers, starts the service, and verifies `/health`. Use `--no-start` to write
artifacts without starting, `--no-install-codex-roles` to skip role generation, and `--yolo` to
enable `allowDangerousSkipPermissions` plus bypass roles (standalone
`install-codex-roles --yolo --config <path>` fails unless that config already opts in).

Generated role files are marked; updates preserve your `query_params` tweaks, unmarked same-name
files cause a hard failure, and stale roles for missing drivers are removed. Claude Code and
Antigravity are optional capabilities: an install is healthy with at least one real driver, and
turns targeting unavailable drivers fail explicitly.

### Defaults

| What                        | Where                                                                             |
| --------------------------- | --------------------------------------------------------------------------------- |
| config                      | `${XDG_CONFIG_HOME:-$HOME/.config}/caara/config.yaml`                             |
| state / receipts / sessions | `${XDG_STATE_HOME:-$HOME/.local/state}/caara` (or `CAARA_STATE_DIR`)              |
| app log                     | `<state>/logs/caara.log`, rotated at 10 MiB, 3 files retained                     |
| macOS service               | `dev.caara` in `~/Library/LaunchAgents/dev.caara.plist`                           |
| Linux service               | `caara.service` in `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/caara.service` |

Config keys are strict YAML: `host`, `port`, `allowDangerousSkipPermissions`, `path`, `logFile`.
CLI flags override YAML; YAML overrides built-in defaults. Foreground runs prepend config `path`
entries to the inherited `PATH`; installed services prepend them to built-in defaults including
`$HOME/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, and `/bin`.

> [!WARNING]
> A non-loopback `host` exposes an unauthenticated local agent bridge. Use one only in controlled
> setups, such as containerized isolation with bind-mounted workspaces.

### Running from source

```bash
bun install
bun run start                    # foreground bridge on 127.0.0.1:8787
bun run start --port 8788        # flags: --config, --host, --port, --allow-dangerous-skip-permissions
bun run build:service            # compile the single-file executable to dist/caara
```

## Sessions and state

Session bindings are keyed by external agent kind plus Codex thread id and hold resume metadata
only; the external agent remains the source of truth for its own conversation. Changing the
requested model or driver options on an existing thread updates that binding's desired state
rather than creating a new session identity. If a session cannot be resumed, the agent asks the
managing agent to restate context instead of silently starting over.

## Releases

Release Please owns version bumps, tags, changelog, and GitHub releases. The publish workflow
uploads `caara_<version>_{darwin_arm64,linux_amd64,linux_arm64}.tar.gz` plus `checksums.txt`
(SHA-256), and updates the Homebrew tap. The macOS binary is Developer ID signed and notarized;
macOS is Apple Silicon only.

## Website

The marketing and reference site lives in [`site/`](site/) (Astro + Tailwind, deployed to GitHub
Pages by `.github/workflows/pages.yml`). Local development:

```bash
cd site && bun install && bun run dev
```

## Development

```bash
bun run fmt        # oxfmt
bun run lint       # biome + oxlint
bun run typecheck  # tsgo
bun run test src/claudeAgentSdkDriver/claudeAgentSdkPermissionPolicy.test.ts
```

Conventions: Bun for engine and package manager; Vitest via `bun run test` (never `bun test`);
test files are `*.test.ts`, type tests `*.tst.ts`. Read
[docs/agents/testing-patterns.md](docs/agents/testing-patterns.md) before writing tests, and
[docs/agents/smoke-testing.md](docs/agents/smoke-testing.md) for the manual Codex smoke flow.
Project vocabulary lives in [CONTEXT.md](CONTEXT.md); decisions in [docs/adr/](docs/adr/).

## License

[MIT](LICENSE) © [Bazyli Brzóska](https://github.com/niieani)
