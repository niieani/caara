# Execute The Codex Responses API → Claude Smoke

This authenticated smoke is currently opt-in behind a Codex model-catalog workaround. Read
`docs/agents/smoke-testing.md` completely. Stop unless the user explicitly requested this exact
smoke and supplied/approved a patched GPT-5.6 model catalog with `multi_agent_version: null`.

Launch a fresh real Codex session with the patched catalog passed through `-c model_catalog_json`,
`features.multi_agent=true`, and `features.multi_agent_v2=false`. Use the checked-in
`caara-claude` or generated Claude role. Do not replace native Codex subagent tools with the Caara
CLI or direct HTTP.

In Codex:

1. Spawn one Claude subagent. Give it a unique nonce, ask it to remember the nonce, inspect
   `package.json` read-only, and reply exactly `RESPONSES_CLAUDE_INITIAL_OK <nonce>`.
2. Send a follow-up on the same subagent handle asking for the nonce and initial filename. Require
   exactly `RESPONSES_CLAUDE_CONTINUITY_OK <nonce> package.json`.
3. Send another follow-up requesting a detailed read-only review of every TypeScript source file.
   Establish visible runtime activity, capture the underlying Claude process evidence, close the
   running subagent, and prove the subprocess exited.

Assert Responses commentary/reasoning phases render normally, final answers appear once, the
follow-up resumes the same external Claude session, cancellation is logged, and no repository files
change. Retain Codex rollout, provider log, Claude session log, process snapshots, model catalog,
and exact Codex version under `temp.local/$(date +%F)/responses-claude/<timestamp>/`.

