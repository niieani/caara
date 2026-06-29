import { Context, Layer } from "effect";

/** One executable a registered external-agent driver needs on the service PATH. */
export interface AgentDriverExecutableRequirement {
  readonly driverName: string;
  readonly externalAgentKind: string;
  readonly executableName: string;
}

/** Registry seam that exposes driver-owned executable requirements to operator tooling. */
export class AgentDriverExecutableRequirementsRegistry extends Context.Service<
  AgentDriverExecutableRequirementsRegistry,
  {
    readonly requirements: readonly AgentDriverExecutableRequirement[];
  }
>()("@caara/AgentDriverExecutableRequirementsRegistry") {}

/** Builds a registry layer from already-declared driver executable requirements. */
export const agentDriverExecutableRequirementsRegistryLayer = ({
  requirements,
}: {
  readonly requirements: readonly AgentDriverExecutableRequirement[];
}) => Layer.succeed(AgentDriverExecutableRequirementsRegistry, { requirements });
