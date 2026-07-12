import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Match } from "effect";

import {
  codexAgentsGuidanceBeginMarker,
  codexAgentsGuidanceEndMarker,
  removeCodexAgentsGuidance,
  removeCodexAgentsGuidanceFile,
  renderCodexAgentsGuidanceBlock,
  upsertCodexAgentsGuidance,
  writeCodexAgentsGuidanceFile,
  type CodexAgentsGuidanceUpdate,
} from "./codexAgentsGuidance.ts";

/** Builds one isolated guidance test root under temp.local. */
const testRoot = (): string =>
  path.join(process.cwd(), "temp.local", "2026-07-04", `codex-guidance-${randomUUID()}`);

/** Extracts the written content from one guidance update or fails the test. */
const writtenContent = (update: CodexAgentsGuidanceUpdate): string =>
  Match.valueTags(update, {
    Corrupt: ({ reason }) => assert.fail(`expected Write update, got Corrupt: ${reason}`),
    Delete: () => assert.fail(`expected Write update, got Delete`),
    Unchanged: () => assert.fail(`expected Write update, got Unchanged`),
    Write: ({ content }) => content,
  });

/** Reads one UTF-8 text fixture. */
const readFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() => fs.readFile(filePath, "utf8"));
});

/** Returns whether one fixture path exists. */
const fileExists = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise(() =>
    fs
      .access(filePath)
      .then(() => true)
      .catch(() => false),
  );
});

describe("Codex AGENTS.md guidance block", () => {
  it("renders a marked cross-model block without panel guidance by default", () => {
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: false });

    assert.ok(block.startsWith(codexAgentsGuidanceBeginMarker()));
    assert.ok(block.trimEnd().endsWith(codexAgentsGuidanceEndMarker()));
    assert.match(block, /Cross-model subagents/u);
    assert.match(block, /caara agent start --json/u);
    assert.match(block, /--prompt-file/u);
    assert.match(block, /observationUrl/u);
    assert.match(block, /immediately show/u);
    assert.match(block, /never open, fetch, inspect, or summarize/u);
    assert.match(block, /caara agent wait --json/u);
    assert.match(block, /Exit\s+11/u);
    assert.match(block, /caara agent cancel --json/u);
    assert.match(block, /finalAnswer/u);
    assert.match(block, /does\s+not depend on Codex subagent roles/u);
    assert.ok(!block.includes(`$panel`));
    assert.ok(!block.includes(`~/.codex/agents`));
    assert.ok(!block.includes(`parallel`));
  });

  it("renders the panel paragraph only when the panel skill is installed", () => {
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: true });

    assert.match(block, /\$panel/u);
    assert.match(block, /cross-review/u);
  });

  it("creates a fresh document from an absent source", () => {
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: false });
    const update = upsertCodexAgentsGuidance({ block, source: undefined });

    assert.strictEqual(writtenContent(update), `${block}\n`);
  });

  it("appends after existing user content without touching it", () => {
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: false });
    const update = upsertCodexAgentsGuidance({
      block,
      source: `# My global rules\n\nAlways be kind.\n`,
    });

    const content = writtenContent(update);
    assert.ok(content.startsWith(`# My global rules\n\nAlways be kind.`));
    assert.ok(content.endsWith(`${block}\n`));
  });

  it("replaces an existing marked block idempotently while preserving surroundings", () => {
    const staleBlock = [
      codexAgentsGuidanceBeginMarker(),
      `old caara guidance`,
      codexAgentsGuidanceEndMarker(),
    ].join("\n");
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: true });

    const update = upsertCodexAgentsGuidance({
      block,
      source: `# Rules\n\n${staleBlock}\n\n# More rules\n`,
    });
    const content = writtenContent(update);
    assert.ok(!content.includes(`old caara guidance`));
    assert.ok(content.includes(`$panel`));
    assert.ok(content.startsWith(`# Rules\n`));
    assert.ok(content.includes(`# More rules`));

    const repeated = upsertCodexAgentsGuidance({ block, source: content });
    assert.strictEqual(writtenContent(repeated), content);
  });

  it("reports corrupt marker pairs instead of guessing", () => {
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: false });
    const missingEnd = `${codexAgentsGuidanceBeginMarker()}\norphaned\n`;
    const reversed = `${codexAgentsGuidanceEndMarker()}\n${codexAgentsGuidanceBeginMarker()}\n`;

    assert.strictEqual(upsertCodexAgentsGuidance({ block, source: missingEnd })._tag, "Corrupt");
    assert.strictEqual(upsertCodexAgentsGuidance({ block, source: reversed })._tag, "Corrupt");
    assert.strictEqual(removeCodexAgentsGuidance({ source: missingEnd })._tag, "Corrupt");

    const duplicated = `${block}\n\n${block}\n`;
    assert.strictEqual(upsertCodexAgentsGuidance({ block, source: duplicated })._tag, "Corrupt");
    assert.strictEqual(removeCodexAgentsGuidance({ source: duplicated })._tag, "Corrupt");
  });

  it("drops the panel paragraph when the skill is no longer installed", () => {
    const seeded = writtenContent(
      upsertCodexAgentsGuidance({
        block: renderCodexAgentsGuidanceBlock({ panelSkillInstalled: true }),
        source: undefined,
      }),
    );

    const downgraded = writtenContent(
      upsertCodexAgentsGuidance({
        block: renderCodexAgentsGuidanceBlock({ panelSkillInstalled: false }),
        source: seeded,
      }),
    );
    assert.ok(seeded.includes(`$panel`));
    assert.ok(!downgraded.includes(`$panel`));
  });

  it("removes only the managed block and keeps user content", () => {
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: false });
    const seeded = writtenContent(
      upsertCodexAgentsGuidance({ block, source: `# Rules\n\nBe kind.\n` }),
    );

    const content = writtenContent(removeCodexAgentsGuidance({ source: seeded }));
    assert.ok(content.includes(`Be kind.`));
    assert.ok(!content.includes(codexAgentsGuidanceBeginMarker()));
  });

  it("requests deletion when nothing but the managed block existed", () => {
    const block = renderCodexAgentsGuidanceBlock({ panelSkillInstalled: false });
    const seeded = writtenContent(upsertCodexAgentsGuidance({ block, source: undefined }));

    assert.strictEqual(removeCodexAgentsGuidance({ source: seeded })._tag, "Delete");
    assert.strictEqual(
      removeCodexAgentsGuidance({ source: `no markers here\n` })._tag,
      "Unchanged",
    );
  });

  it.effect("writes, rewrites, and removes the guidance file on disk", () =>
    Effect.gen(function* () {
      const agentsFilePath = path.join(testRoot(), "AGENTS.md");

      const writtenPath = yield* writeCodexAgentsGuidanceFile({
        agentsFilePath,
        panelSkillInstalled: false,
      });
      const first = yield* readFile({ filePath: agentsFilePath });
      assert.strictEqual(writtenPath, agentsFilePath);
      assert.ok(!first.includes(`$panel`));

      yield* writeCodexAgentsGuidanceFile({ agentsFilePath, panelSkillInstalled: true });
      const second = yield* readFile({ filePath: agentsFilePath });
      assert.ok(second.includes(`$panel`));
      assert.strictEqual(second.split(codexAgentsGuidanceBeginMarker()).length, 2);

      const removedPath = yield* removeCodexAgentsGuidanceFile({ agentsFilePath });
      assert.strictEqual(removedPath, agentsFilePath);
      assert.strictEqual(yield* fileExists({ filePath: agentsFilePath }), false);
    }),
  );

  it.effect("preserves user content on disk when removing the managed block", () =>
    Effect.gen(function* () {
      const root = testRoot();
      const agentsFilePath = path.join(root, "AGENTS.md");
      yield* Effect.tryPromise(() => fs.mkdir(root, { recursive: true }));
      yield* Effect.tryPromise(() => fs.writeFile(agentsFilePath, `# Mine\n\nKeep me.\n`, "utf8"));

      yield* writeCodexAgentsGuidanceFile({ agentsFilePath, panelSkillInstalled: false });
      yield* removeCodexAgentsGuidanceFile({ agentsFilePath });

      const content = yield* readFile({ filePath: agentsFilePath });
      assert.ok(content.includes(`Keep me.`));
      assert.ok(!content.includes(codexAgentsGuidanceBeginMarker()));
    }),
  );

  it.effect("treats an absent guidance file as already removed", () =>
    Effect.gen(function* () {
      const agentsFilePath = path.join(testRoot(), "AGENTS.md");
      const removedPath = yield* removeCodexAgentsGuidanceFile({ agentsFilePath });
      assert.strictEqual(removedPath, undefined);
    }),
  );
});
