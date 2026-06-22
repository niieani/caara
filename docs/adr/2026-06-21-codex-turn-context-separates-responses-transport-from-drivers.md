# Codex turn context separates Responses transport from drivers

Caara accepts Codex subagent turns through a Responses-compatible HTTP/SSE transport, but drivers
for Claude Code, ACP agents, and other external code agents should not receive raw Responses
requests or raw Codex headers. We will decode Codex-specific identity and workspace metadata into a
`CodexTurnContext` at the transport edge, then drive selected agent targets through a single
`startOrResumeTurn(...) -> Stream<AgentRuntimeEvent>` seam. This keeps Codex transport quirks local,
lets drivers hide their own session/process lifecycle policy, and prevents external agent session
state from being keyed accidentally by the parent Codex session instead of the stable Codex thread.
