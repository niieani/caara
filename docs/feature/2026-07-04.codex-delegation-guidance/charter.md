# Charter: Codex delegation guidance (AGENTS.md block + global panel skill)

## Ask

Make Codex actually *reach for* caara subagents. Roles alone don't change behavior; global
`~/.codex/AGENTS.md` guidance does. Two deliverables:

1. Docs: README section + site quickstart step recommending the guidance snippet.
2. CLI: opt-in flags on `install-codex-roles` — `--agents-md` writes a managed block into
   `$CODEX_HOME/AGENTS.md`; `--panel-skill` installs the repo's panel skill globally into
   `$CODEX_HOME/skills/panel`. Separate opt-ins. NEVER automatic.

## Settled decisions (user)

- Snippet must NOT: tell Codex where role files live (it knows at runtime); recommend caara for
  parallelism or context-budget reasons (native subagents cover that; user's call). Framing is
  purely *cross-model value*: review, second opinions, contested design calls, different model
  family perspective.
- Snippet references the panel skill as global `$panel` (hence the `--panel-skill` opt-in), not
  "repo's panel skill if present".
- No automatic editing of AGENTS.md or skill install during brew/service install. Opt-in flags on
  the role-install command only.

## Design decisions

- Managed AGENTS.md block between `<!-- caara:agents:begin -->` / `<!-- caara:agents:end -->`
  markers; idempotent upsert (replace block if markers present, else append; create file if
  absent). Uninstall removes block; deletes file if only whitespace remains.
- Block mentions `$panel` only when the panel skill is present at `$CODEX_HOME/skills/panel`
  after the run (installed now or previously).
- Panel skill copied from embedded assets (`with { type: "text" }` imports — Bun inlines into
  compiled binary). Marker file `.caara-generated` in the installed dir marks ownership.
  Existing unmarked `skills/panel` → refuse (mirrors role collision policy).
- Skill/AGENTS.md destination always derived from CODEX_HOME/HOME env (never from the roles
  target-dir arg). Flags given without resolvable home → hard error.
- `uninstall-codex-roles` also removes the marked skill dir + managed block unconditionally
  (cleanup of caara-owned, marked artifacts only).
- vitest needs a small `.md`→string vite plugin (vite can't parse md imports; verified by
  experiment). TS side: `declare module "*.md"`.

## Out of scope

- Wiring opt-ins through `install-service` / brew flow or service config keys.
- Any change to role TOML generation or the panel skill content itself.

## Criteria & verification

| Criterion | Verifier |
| --- | --- |
| `--agents-md` writes managed block; idempotent across reruns; preserves user content around it | unit tests on pure upsert + installer integration test |
| `--panel-skill` installs all 5 skill files + marker; refuses unmarked existing dir; updates marked dir | installer integration tests |
| `$panel` paragraph present iff skill present after run | integration tests both ways |
| uninstall removes block + marked skill; leaves user content; never touches unmarked | integration tests |
| embedded assets stay in sync with `.agents/skills/panel/**` | sync test comparing embedded record to source tree |
| no regression in existing role install/uninstall | existing test files pass |
| compiled binary embeds assets | `bun run build:service` + run binary `install-codex-roles --panel-skill` against temp CODEX_HOME |
| README + site updated | review; site builds (`bun run build` in site/) |

Execution shape: single-session, 4 slices, sequential, commit at end. Review subagent after
implementation.
