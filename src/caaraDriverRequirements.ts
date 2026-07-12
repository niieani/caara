import {
  agentDriverExecutableRequirementsRegistryLayer,
  type AgentDriverExecutableRequirement,
} from "./agentDriverRequirements.ts";
import { antigravityCliExecutableRequirements } from "./antigravityCliDriver/driver.ts";
import { claudeAgentSdkExecutableRequirements } from "./claudeAgentSdkDriver/driver.ts";
import { codexCliExecutableRequirements } from "./codexCliDriver/client.ts";
import { diagnosticAgentDriverExecutableRequirements } from "./mockResponsesProvider/diagnosticDriver.ts";

/** Executable requirements declared by all currently registered Caara drivers. */
export const caaraAgentDriverExecutableRequirements = [
  ...diagnosticAgentDriverExecutableRequirements,
  ...claudeAgentSdkExecutableRequirements,
  ...antigravityCliExecutableRequirements,
  ...codexCliExecutableRequirements,
] as const satisfies readonly AgentDriverExecutableRequirement[];

/** Live registry layer exposing driver-owned executable requirements. */
export const caaraAgentDriverExecutableRequirementsLive =
  agentDriverExecutableRequirementsRegistryLayer({
    requirements: caaraAgentDriverExecutableRequirements,
  });

/** Live registry service value used by in-process CLI commands. */
export const caaraAgentDriverExecutableRequirementsRegistry = {
  requirements: caaraAgentDriverExecutableRequirements,
};
