import type { Ref } from "effect";

import type { AgentTurnExecution } from "./mockResponsesProvider/agentTurn.ts";
import type { ObservationCapability } from "./portableAgentIdentity.ts";
import type {
  PortableTurnObservation,
  PortableTurnTerminalProjection,
} from "./portableAgentTurn.ts";

/** Mutable projection state shared by runtime projection and cancellation orchestration. */
export interface PortableTurnProjectionState {
  readonly itemPhases: ReadonlyMap<string, "commentary" | "final_answer" | undefined>;
  readonly terminal: PortableTurnTerminalProjection;
  readonly observation: PortableTurnObservation;
  readonly finalization: "open" | "cancelling" | "terminal";
  readonly durableCancellationCommitted: boolean;
  readonly observationCancellationCommitted: boolean;
}

/** Live portable turn record retained while driver cancellation remains possible. */
export interface PortableTurnRecord {
  readonly capability: ObservationCapability;
  readonly sessionId: string;
  readonly createdAtMillis: number;
  readonly expiresAtMillis: number;
  readonly state: Ref.Ref<PortableTurnProjectionState>;
  readonly cancel: AgentTurnExecution["cancel"];
}
