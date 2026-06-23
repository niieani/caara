import {
  createAssistantTextRuntimeEvents,
  createRuntimeTurnSucceededEvent,
  type AgentRuntimeEvent,
} from "./agentDriver.ts";

/** Assistant reply emitted when Caara has to replace an unresumable external-agent session. */
export const lostSessionRecoveryAssistantText =
  "I lost the external agent session context. Remind me, what did we discuss prior to this message, restate any relevant context and your request.";

/** Prompt sent to a fresh external agent only to prove that a replacement session can start. */
export const lostSessionRecoveryDriverPrompt = `Reply with exactly this text and nothing else:\n\n${lostSessionRecoveryAssistantText}`;

/** Builds the Caara-owned final-answer recovery runtime event sequence. */
export const createLostSessionRecoveryRuntimeEvents = (): readonly AgentRuntimeEvent[] => [
  ...createAssistantTextRuntimeEvents({
    itemId: "lost-session-recovery-message",
    messagePhase: "final_answer",
    text: lostSessionRecoveryAssistantText,
  }),
  createRuntimeTurnSucceededEvent(),
];
