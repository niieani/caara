import type { AgentTurnDelegation } from "./agentDelegation.ts";

/** Stable transport-neutral identity of an Agent session and its current turn. */
export interface AgentTurnSessionIdentity {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly turnId: string;
}

/** Identifies the transport adapter that originated an Agent turn. */
export interface AgentTurnOrigin {
  readonly transport: string;
}

/** Transport-neutral advisory signals an external-agent driver may interpret. */
export interface AgentTurnAdvisories {
  readonly effort: "low" | "medium" | "high" | "xhigh" | undefined;
  readonly sandboxPosture: "enforced" | "none";
}

/** Shared domain context for Agent Turn, session, concurrency, and driver boundaries. */
export interface AgentTurnContext {
  readonly identity: AgentTurnSessionIdentity;
  readonly origin: AgentTurnOrigin;
  readonly delegation: AgentTurnDelegation;
  readonly advisories: AgentTurnAdvisories;
  readonly requestedCwd: string | undefined;
}
