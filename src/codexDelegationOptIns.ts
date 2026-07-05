import path from "node:path";

import { Effect, Match, Option } from "effect";

import {
  preflightCodexAgentsGuidanceFile,
  removeCodexAgentsGuidanceFile,
  writeCodexAgentsGuidanceFile,
} from "./codexAgentsGuidance.ts";
import { caaraCodexRoleInstallerError } from "./codexRoleInstallerError.ts";
import type { InstallCodexRolesOptions } from "./codexRoleInstallerOptions.ts";
import {
  installPanelSkill,
  isPanelSkillPresent,
  panelSkillCollisionPath,
  removePanelSkill,
} from "./codexSkillInstaller.ts";

/** Opt-in delegation artifact locations under one Codex home directory. */
export interface DelegationOptInTargets {
  readonly agentsFilePath: string;
  readonly skillsDirectory: string;
}

/** Derives opt-in delegation artifact locations from one Codex home directory. */
export const delegationTargetsFromHome = ({
  codexHome,
}: {
  readonly codexHome: string;
}): DelegationOptInTargets => ({
  agentsFilePath: path.join(codexHome, "AGENTS.md"),
  skillsDirectory: path.join(codexHome, "skills"),
});

/** Returns a validation failure when opt-in flags lack a resolvable Codex home. */
export const optInHomeValidationFailure = ({
  codexHome,
  options,
}: {
  readonly codexHome: string | undefined;
  readonly options: InstallCodexRolesOptions;
}): string | undefined =>
  ["caara install-codex-roles --panel-skill and --agents-md require HOME or CODEX_HOME to be set."]
    .filter(() => (options.agentsMd || options.panelSkill) && codexHome === undefined)
    .at(0);

/** Written or removed opt-in delegation artifacts reported alongside role changes. */
export interface DelegationOptInReport {
  readonly messages: readonly string[];
  readonly writtenFiles: readonly string[];
}

/** Empty opt-in delegation report used when no opt-in flag is set. */
const emptyDelegationReport: DelegationOptInReport = { messages: [], writtenFiles: [] };

/** Returns a refusal message from opt-in preflights, or undefined when writes may proceed. */
export const preflightDelegationOptIns = Effect.fnUntraced(function* ({
  options,
  targets,
}: {
  readonly options: InstallCodexRolesOptions;
  readonly targets: DelegationOptInTargets | undefined;
}) {
  const presentTargets = [targets].filter((candidate) => candidate !== undefined);
  const skillCollisions = yield* Effect.forEach(
    presentTargets.filter(() => options.panelSkill),
    (candidate) => panelSkillCollisionFailure({ skillsDirectory: candidate.skillsDirectory }),
    { concurrency: 1 },
  );
  const guidanceCorruptions = yield* Effect.forEach(
    presentTargets.filter(() => options.agentsMd),
    (candidate) =>
      guidanceCorruptionFailure({
        agentsFilePath: candidate.agentsFilePath,
        commandName: "install-codex-roles",
      }),
    { concurrency: 1 },
  );
  return [...skillCollisions, ...guidanceCorruptions].find((failure) => failure !== undefined);
});

/** Returns a refusal message when an unmarked user-owned panel skill blocks installation. */
const panelSkillCollisionFailure = Effect.fnUntraced(function* ({
  skillsDirectory,
}: {
  readonly skillsDirectory: string;
}) {
  const collisionPath = yield* panelSkillCollisionPath({ skillsDirectory });
  return Option.match(Option.fromUndefinedOr(collisionPath), {
    onNone: () => undefined,
    onSome: (blockedPath) =>
      `caara install-codex-roles refused unmarked existing Codex panel skill: ${blockedPath}`,
  });
});

/** Returns a refusal message when the guidance document carries a broken marker pair. */
const guidanceCorruptionFailure = Effect.fnUntraced(function* ({
  agentsFilePath,
  commandName,
}: {
  readonly agentsFilePath: string;
  readonly commandName: string;
}) {
  const reason = yield* preflightCodexAgentsGuidanceFile({ agentsFilePath });
  return Option.match(Option.fromUndefinedOr(reason), {
    onNone: () => undefined,
    onSome: (corruptionReason) =>
      `caara ${commandName} refused corrupt Codex AGENTS.md at ${agentsFilePath}: ${corruptionReason}`,
  });
});

/** Returns a refusal message when the managed guidance block cannot be safely removed. */
export const preflightDelegationCleanup = Effect.fnUntraced(function* ({
  codexHome,
}: {
  readonly codexHome: string | undefined;
}) {
  const failures = yield* Effect.forEach(
    [codexHome].filter((home) => home !== undefined),
    (home) =>
      guidanceCorruptionFailure({
        agentsFilePath: delegationTargetsFromHome({ codexHome: home }).agentsFilePath,
        commandName: "uninstall-codex-roles",
      }),
    { concurrency: 1 },
  );
  return failures.find((failure) => failure !== undefined);
});

/** Installs the panel skill opt-in and reports the written files. */
const applyPanelSkillOptIn = Effect.fnUntraced(function* ({
  skillsDirectory,
}: {
  readonly skillsDirectory: string;
}) {
  const installed = yield* installPanelSkill({ skillsDirectory });
  return yield* Match.valueTags(installed, {
    Collision: ({ skillDirectory }) =>
      Effect.fail(
        caaraCodexRoleInstallerError(
          `caara install-codex-roles refused unmarked existing Codex panel skill: ${skillDirectory}`,
        ),
      ),
    Installed: ({ skillDirectory, writtenFiles }) =>
      Effect.succeed({
        messages: [`installed panel skill to ${skillDirectory}`],
        writtenFiles,
      } satisfies DelegationOptInReport),
  });
});

/** Writes the AGENTS.md guidance opt-in and reports the written file. */
const applyAgentsMdOptIn = Effect.fnUntraced(function* ({
  agentsFilePath,
  skillsDirectory,
}: {
  readonly agentsFilePath: string;
  readonly skillsDirectory: string;
}) {
  const panelSkillInstalled = yield* isPanelSkillPresent({ skillsDirectory });
  const writtenPath = yield* writeCodexAgentsGuidanceFile({
    agentsFilePath,
    panelSkillInstalled,
  });
  return {
    messages: [`updated Codex AGENTS.md guidance at ${agentsFilePath}`],
    writtenFiles: [writtenPath].filter((filePath) => filePath !== undefined),
  } satisfies DelegationOptInReport;
});

/** Installs opt-in delegation artifacts after roles were written. */
export const applyDelegationOptIns = Effect.fnUntraced(function* ({
  options,
  targets,
}: {
  readonly options: InstallCodexRolesOptions;
  readonly targets: DelegationOptInTargets | undefined;
}) {
  const presentTargets = [targets].filter((candidate) => candidate !== undefined);
  const skillReports = yield* Effect.forEach(
    presentTargets.filter(() => options.panelSkill),
    ({ skillsDirectory }) => applyPanelSkillOptIn({ skillsDirectory }),
    { concurrency: 1 },
  );
  const guidanceReports = yield* Effect.forEach(
    presentTargets.filter(() => options.agentsMd),
    ({ agentsFilePath, skillsDirectory }) => applyAgentsMdOptIn({ agentsFilePath, skillsDirectory }),
    { concurrency: 1 },
  );
  const reports = [emptyDelegationReport, ...skillReports, ...guidanceReports];
  return {
    messages: reports.flatMap((report) => report.messages),
    writtenFiles: reports.flatMap((report) => report.writtenFiles),
  } satisfies DelegationOptInReport;
});

/** Removed opt-in delegation artifacts reported alongside role cleanup. */
export interface DelegationCleanupReport {
  readonly messages: readonly string[];
  readonly removedPaths: readonly string[];
}

/** Removes Caara-owned delegation artifacts (panel skill, AGENTS.md block) under one Codex home. */
export const removeDelegationArtifacts = Effect.fnUntraced(function* ({
  codexHome,
}: {
  readonly codexHome: string;
}) {
  const targets = delegationTargetsFromHome({ codexHome });
  const removedSkillDirectory = yield* removePanelSkill({
    skillsDirectory: targets.skillsDirectory,
  });
  const removedGuidancePath = yield* removeCodexAgentsGuidanceFile({
    agentsFilePath: targets.agentsFilePath,
  });
  return {
    messages: [
      ...[`removed panel skill from ${removedSkillDirectory}`].filter(
        () => removedSkillDirectory !== undefined,
      ),
      ...[`removed Codex AGENTS.md guidance from ${removedGuidancePath}`].filter(
        () => removedGuidancePath !== undefined,
      ),
    ],
    removedPaths: [removedSkillDirectory, removedGuidancePath].filter(
      (removedPath) => removedPath !== undefined,
    ),
  } satisfies DelegationCleanupReport;
});
