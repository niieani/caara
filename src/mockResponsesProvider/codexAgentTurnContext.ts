import type { AgentTurnDelegation } from "./agentDelegation.ts";
import type { AgentTurnContext } from "./agentTurnContext.ts";
import type { CodexTurnContext } from "./codexTurnContext.ts";

/** Adapts validated Responses/Codex metadata into the transport-neutral Agent Turn context. */
export const agentTurnContextFromCodex = ({
  codex,
  delegation,
  transport = "responses",
}: {
  readonly codex: CodexTurnContext;
  readonly delegation: AgentTurnDelegation;
  readonly transport?: string;
}): AgentTurnContext => ({
  identity: {
    sessionId: codex.threadId,
    parentSessionId: codex.parentSessionId,
    turnId: codex.turnId,
  },
  origin: { transport },
  delegation,
  advisories: {
    effort: codex.advisoryEffort,
    sandboxPosture: codex.sandboxPosture,
  },
  requestedCwd: [...codex.workspacePaths, ...codex.cwdCandidates].at(0),
});
