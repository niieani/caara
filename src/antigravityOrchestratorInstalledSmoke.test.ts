import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

/** Explicit opt-in preventing normal tests from invoking Antigravity or the installed service. */
const realAntigravitySmokeEnabled = process.env.CAARA_REAL_ANTIGRAVITY_ORCHESTRATOR_SMOKE === "1";

/** Antigravity executable selected by the operator. */
const antigravityExecutable = process.env.CAARA_SMOKE_ANTIGRAVITY_EXECUTABLE ?? "agy";

/** Exact terminal marker requested from the delegated Claude turn. */
const finalMarker = (): string => "ANTIGRAVITY_ORCHESTRATOR_SMOKE_FINAL";

/** Managing-agent prompt requiring the installed global guidance workflow. */
const smokePrompt = (): string =>
  [
    "Follow the Caara portable blind-delegation rules in your global GEMINI.md.",
    "Delegate to claude/sonnet through the installed Caara service and portable CLI.",
    "Ask Claude to inspect package.json read-only and reply exactly",
    `${finalMarker()}. Surface observationUrl immediately, never inspect it, then return only`,
    "Claude's final answer. Do not use native Antigravity subagent tools. Do not modify files.",
  ].join(" ");

/** Transcript fields needed to distinguish model speech from tool inputs. */
const SmokeTranscriptRecord = Schema.Struct({
  step_index: Schema.Finite,
  source: Schema.String,
  type: Schema.String,
  status: Schema.String,
  content: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** Decoded subset of one Antigravity transcript row. */
type SmokeTranscriptRecord = typeof SmokeTranscriptRecord.Type;

/** Extracts the fresh Antigravity conversation id from its required diagnostic log. */
const conversationIdFromLog = ({ source }: { readonly source: string }): string => {
  const id = /Created conversation ([0-9a-f-]{36})/iu.exec(source)?.[1];
  assert.ok(id, "Antigravity log did not contain a created conversation id");
  return id;
};

/** Decodes the complete real Antigravity transcript through a strict structural subset. */
const decodeTranscript = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  const source = yield* Effect.promise(() => fs.readFile(filePath, "utf8"));
  return yield* Effect.forEach(
    source.split("\n").filter((line) => line.length > 0),
    (line) => Schema.decodeUnknownEffect(Schema.fromJsonString(SmokeTranscriptRecord))(line),
  );
});

/** Encodes only structural tool-input fields, excluding command output content. */
const encodedToolInputs = (record: SmokeTranscriptRecord): string =>
  Schema.encodeSync(Schema.UnknownFromJsonString)({
    args: record.args,
    tool_calls: record.tool_calls,
  });

/** Runs one real noninteractive Antigravity managing turn and returns its retained evidence. */
const runRealAntigravitySmoke = Effect.fnUntraced(function* () {
  const home = process.env.HOME;
  assert.ok(home, "HOME is required for the real Antigravity smoke");
  const runDirectory = path.join(
    process.cwd(),
    "temp.local",
    "2026-07-12",
    `antigravity-orchestrator-smoke-${randomUUID()}`,
  );
  const logFile = path.join(runDirectory, "agy.log");
  yield* Effect.promise(() => fs.mkdir(runDirectory, { recursive: true }));
  const child = Bun.spawn(
    [
      antigravityExecutable,
      "--prompt",
      smokePrompt(),
      "--model",
      "gemini-3.5-flash",
      "--log-file",
      logFile,
      "--print-timeout",
      "300s",
    ],
    { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]),
  );
  yield* Effect.promise(() => fs.writeFile(path.join(runDirectory, "stdout.txt"), stdout, "utf8"));
  yield* Effect.promise(() => fs.writeFile(path.join(runDirectory, "stderr.txt"), stderr, "utf8"));
  assert.strictEqual(exitCode, 0, stderr);
  const log = yield* Effect.promise(() => fs.readFile(logFile, "utf8"));
  const conversationId = conversationIdFromLog({ source: log });
  const transcriptPath = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
  return { stdout, records: yield* decodeTranscript({ filePath: transcriptPath }) };
});

describe.runIf(realAntigravitySmokeEnabled)(
  "installed Antigravity orchestrator guidance smoke",
  () => {
    it.live(
      "surfaces the Claude viewer before the exact final without leaking capability to tools",
      () =>
        Effect.gen(function* () {
          const { stdout, records } = yield* runRealAntigravitySmoke();
          const modelResponses = records.filter(
            ({ source, type, status }) =>
              source === "MODEL" && type === "PLANNER_RESPONSE" && status === "DONE",
          );
          const urlRecord = modelResponses.find(({ content }) =>
            /http:\/\/127\.0\.0\.1:\d+\/observe\/[A-Za-z0-9-]+/u.test(content ?? ""),
          );
          assert.ok(urlRecord, "Antigravity did not surface the observation URL in model speech");
          const observationUrl = urlRecord.content?.match(
            /http:\/\/127\.0\.0\.1:\d+\/observe\/[A-Za-z0-9-]+/u,
          )?.[0];
          assert.ok(observationUrl);
          const finalRecord = modelResponses.findLast(
            ({ content }) => content?.trim() === finalMarker(),
          );
          assert.ok(finalRecord, "Antigravity transcript lacked the exact terminal final answer");
          assert.ok(urlRecord.step_index < finalRecord.step_index);
          assert.strictEqual(stdout.trim(), finalMarker());

          assert.deepStrictEqual(
            records.filter(
              (record) =>
                encodedToolInputs(record).includes(observationUrl) ||
                /(?:curl|wget|read_url|browser|open\s+http)[^\n]*\/observe\//iu.test(
                  encodedToolInputs(record),
                ),
            ),
            [],
            "Antigravity passed or inspected the human observation capability in tool input",
          );
          assert.deepStrictEqual(
            records.filter((record) =>
              /subagent|sub_agent|delegate_task|manage_task/iu.test(
                `${record.name ?? ""} ${record.toolName ?? ""} ${record.tool_name ?? ""} ${encodedToolInputs(record)}`,
              ),
            ),
            [],
            "Antigravity used a native subagent tool",
          );
        }),
      360_000,
    );
  },
);
