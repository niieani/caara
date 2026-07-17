# Execute The Cross-Harness MCP Smoke

You are the managing Agent in an authenticated MCP smoke. Read `docs/agents/smoke-testing.md`
completely. Stop unless the user explicitly authorized paid/authenticated execution and configured
the `caara-agent` MCP server for this fresh harness session.

Choose exactly one target different from your own harness:

- Codex orchestrator: `claude/sonnet`;
- Claude orchestrator: `codex/gpt-5.6`;
- Antigravity orchestrator: `claude/sonnet` when Caara MCP discovery is supported.

Use only `caara_agent_start`, `caara_agent_wait`, and `caara_agent_cancel`. Never use native
subagents for this smoke. Never open, retrieve, pass to a tool, or summarize an `observationUrl`;
surface each URL immediately to the user as plain assistant text.

Lifecycle:

1. Generate a unique nonce. Start a read-only turn asking the target to remember it, inspect
   `package.json`, and reply exactly `MCP_INITIAL_OK <nonce>`. Wait until completion and report the
   exact final answer.
2. Start with the returned `sessionId`. Ask which nonce and file were in the initial request.
   Require exactly `MCP_CONTINUITY_OK <nonce> package.json`.
3. Start another follow-up on that session requesting a detailed read-only review of every
   TypeScript source file. Wait until it is working and activity has been independently confirmed by
   the trusted smoke operator, then cancel the exact turn. Report only the typed cancellation
   outcome.

Assertions to report:

- tool discovery exposed exactly start/wait/cancel and no resources, prompts, transcript reader, or
  MCP Task requirement;
- working waits retained turn/session identifiers and observation URL;
- no MCP result/error included reasoning, commentary, tools, transcript fields, viewer HTML, or
  private activity;
- the same session was used for all three turns;
- the trusted smoke operator confirmed the harness PID exited after cancellation.

Return a compact assertion report plus terminal answers. Do not modify files or MCP configuration.

