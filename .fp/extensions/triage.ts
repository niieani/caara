/**
 * Registers the triage property used by fp issues in this project.
 *
 * The property is separate from the built-in fp status field: status tracks
 * work execution (`todo`, `in-progress`, `done`), while triage tracks the
 * routing decision that agent workflows use before implementation starts.
 */
import type { FpExtensionContext, PropertyOption } from "@fiberplane/extensions";

/**
 * Builds the canonical triage states shown in fp's issue property UI.
 */
const triageOptions = ({ ui }: FpExtensionContext): readonly PropertyOption[] => [
  ui.properties.option("needs-triage", {
    label: "Needs triage",
    icon: "circle-dot",
    color: "warning",
  }),
  ui.properties.option("needs-info", {
    label: "Needs info",
    icon: "info",
    color: "blue",
  }),
  ui.properties.option("ready-for-agent", {
    label: "Ready for agent",
    icon: "terminal",
    color: "success",
  }),
  ui.properties.option("ready-for-human", {
    label: "Ready for human",
    icon: "user",
    color: "purple",
  }),
  ui.properties.option("wontfix", {
    label: "Won't fix",
    icon: "x",
    color: "destructive",
  }),
];

/**
 * Extension entrypoint called by fp during project extension initialization.
 */
export default async function triage(fp: FpExtensionContext): Promise<void> {
  await fp.issues.registerProperty("triage", {
    label: "Triage",
    icon: "git-branch",
    display: fp.ui.properties.select(...triageOptions(fp)),
  });
}
