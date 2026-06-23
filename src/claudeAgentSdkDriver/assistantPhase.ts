import { Match } from "effect";

import type { AgentRuntimeMessagePhase } from "../mockResponsesProvider/agentDriver.ts";

/** Selects the Codex-visible assistant message phase from Claude's terminal stop reason. */
export const messagePhaseFromAssistantStopReason = (
  stopReason: string | null | undefined,
): AgentRuntimeMessagePhase =>
  Match.value(stopReason).pipe(
    Match.when("tool_use", () => "commentary" as const),
    Match.orElse(() => "final_answer" as const),
  );
