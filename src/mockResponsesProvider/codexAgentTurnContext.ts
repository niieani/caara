import type { AgentTurnContext } from "./agentTurnContext.ts";
import type { CodexTurnContext } from "./codexTurnContext.ts";

/** Adapts validated Responses/Codex metadata into the transport-neutral Agent Turn context. */
export const agentTurnContextFromCodex = ({
  codex,
  transport = "responses",
}: {
  readonly codex: CodexTurnContext;
  readonly transport?: string;
}): AgentTurnContext => ({
  identity: {
    sessionId: codex.threadId,
    parentSessionId: codex.parentSessionId,
    turnId: codex.turnId,
  },
  origin: { transport, metadata: {} },
  advisories: {
    effort: codex.advisoryEffort,
    sandboxPosture: codex.sandboxPosture,
  },
  requestedCwd: [...codex.workspacePaths, ...codex.cwdCandidates].at(0),
});
