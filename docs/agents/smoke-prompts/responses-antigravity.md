# Execute The Codex Responses API → Antigravity Smoke

This authenticated smoke is currently opt-in behind a Codex model-catalog workaround. Read
`docs/agents/smoke-testing.md` completely. Stop unless the user explicitly requested this exact
smoke and supplied/approved a patched GPT-5.6 model catalog with `multi_agent_version: null`.

Launch a fresh real Codex session with the patched catalog passed through `-c model_catalog_json`,
`features.multi_agent=true`, and `features.multi_agent_v2=false`. Use the checked-in
`caara-antigravity` or generated Antigravity role. Do not replace native Codex subagent tools with
the Caara CLI or direct HTTP.

In Codex:

1. Spawn one Antigravity subagent. Give it a unique nonce, ask it to remember the nonce, inspect
   `package.json` read-only, and reply exactly `RESPONSES_AGY_INITIAL_OK <nonce>`.
2. Send a follow-up on the same subagent handle asking for the nonce and initial filename. Require
   exactly `RESPONSES_AGY_CONTINUITY_OK <nonce> package.json`.
3. Send another follow-up requesting a detailed read-only review of every TypeScript source file.
   Establish visible runtime activity/transcript mutation, capture the `agy` process evidence,
   close the running subagent, and prove the subprocess exited.

Assert Responses commentary/reasoning phases render normally, final answers appear once, the
follow-up resumes the same Antigravity conversation, cancellation follows the conservative
reusability policy, and no repository files change. Retain Codex rollout, provider log,
Antigravity transcript, process snapshots, model catalog, and exact Codex version under
`temp.local/$(date +%F)/responses-antigravity/<timestamp>/`.

