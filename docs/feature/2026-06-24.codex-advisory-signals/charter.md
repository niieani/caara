# Codex advisory signals

## Brief

Implement PRD `CAARA-azkuijvf`: decode Codex advisory effort/sandbox signals, expose them at the driver seam, let Claude and Antigravity map them only as fallbacks behind driver query params, and update Caara Codex role docs/configs.

## Goal

Caara validates advisory Codex input at the transport edge and passes a typed `AgentDriverTurn.codex` context to drivers. Driver-owned query params remain highest precedence. Sandbox posture is coarse: `none` or `enforced`.

## Scope

In scope:
- `src/mockResponsesProvider/codexTurnContext.ts` and tests for advisory decoding.
- Driver contract/diagnostic path proving advisory values reach `AgentDriverTurn`.
- Claude SDK driver option mapping from advisory effort when `?effort=` absent.
- Antigravity CLI sandbox mapping from advisory posture when `?sandbox=` absent.
- Checked-in `.codex/agents/caara-*.toml`, `docs/caara.md`, `README.md`, smoke runbooks under `docs/agents/`.

Out of scope:
- Global Caara permission policy.
- Driver support for exact Codex sandbox modes beyond `none | enforced`.
- Backward-compatible legacy paths beyond existing behavior.

## Criteria

- Valid `reasoning.effort` values `low | medium | high | xhigh` visible on `AgentDriverTurn.codex`.
- Missing advisory effort stays absent.
- Unsupported present advisory effort fails as invalid request.
- Metadata sandbox `none` maps to posture `none`; enforced tags such as `workspace-write` map to `enforced`.
- Existing identity metadata hard failures stay intact.
- Driver query params override comparable advisory signals.
- Focused and full validation required per child issue: `bun lint`, `bun run test --run`, `bun run fmt`.

## Execution

One PRD workdesk for all children. Child order follows fp dependencies: shared seam, then Claude, Antigravity, role/docs. Each child gets red tests first, completion comment, done status, atomic semantic commit linked to fp issue.
