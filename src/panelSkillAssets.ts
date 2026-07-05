import panelReadme from "../.agents/skills/panel/README.md" with { type: "text" };
import panelSkill from "../.agents/skills/panel/SKILL.md" with { type: "text" };
import panelistContract from "../.agents/skills/panel/panelist-contract.md" with { type: "text" };
import strategyCrossReview from "../.agents/skills/panel/strategies/cross-review.md" with {
  type: "text",
};
import strategyDebate from "../.agents/skills/panel/strategies/debate.md" with { type: "text" };
import strategyEnsemble from "../.agents/skills/panel/strategies/ensemble.md" with {
  type: "text",
};

/**
 * Panel skill files embedded into the Caara binary, keyed by skill-relative POSIX path.
 * The authoritative sources live in `.agents/skills/panel/`; panelSkillAssets.test.ts fails when
 * this record drifts from them (add the matching import here when the skill gains a file).
 */
export const panelSkillAssets: Readonly<Record<string, string>> = {
  "README.md": panelReadme,
  "SKILL.md": panelSkill,
  "panelist-contract.md": panelistContract,
  "strategies/cross-review.md": strategyCrossReview,
  "strategies/debate.md": strategyDebate,
  "strategies/ensemble.md": strategyEnsemble,
};
