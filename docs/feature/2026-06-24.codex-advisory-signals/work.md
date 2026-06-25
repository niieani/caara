# Work

## Design

Add a small typed advisory model to `CodexTurnContext`:

- `effort?: "low" | "medium" | "high" | "xhigh"`
- `sandboxPosture: "none" | "enforced"`

Decode effort from Responses body `reasoning.effort`; invalid present values fail at request decode. Decode sandbox from validated `x-codex-turn-metadata.sandbox`; only literal `none` is no sandbox, every other string is an enforced posture.

Keep `AgentTarget.rawDriverOptions` separate. Drivers decide how to map advisory values after parsing their own query options.

## Slice Order

1. `CAARA-wfycnuhk`: shared decoder + driver seam contract tests.
2. `CAARA-cqsnthbk`: Claude effort fallback behind `?effort=`.
3. `CAARA-nvbxmoas`: Antigravity sandbox fallback behind `?sandbox=`.
4. `CAARA-dldgwavm`: role configs and docs.

## Validation

Focused tests per changed area first, then required child completion commands:

- `bun lint`
- `bun run test --run`
- `bun run fmt`

Full suite runs before each child is marked done per PRD workflow.
