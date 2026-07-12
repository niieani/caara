import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

/** Explicit opt-in preventing normal tests from invoking Claude, credentials, or user services. */
const realClaudeSmokeEnabled = process.env.CAARA_REAL_CLAUDE_PORTABLE_SMOKE === "1";

/** Claude executable selected by the operator running the installed smoke. */
const claudeExecutable = process.env.CAARA_SMOKE_CLAUDE_EXECUTABLE ?? "claude";

/** Stable final marker requested from the real delegated Antigravity turn. */
const finalMarker = (): string => "CLAUDE_PORTABLE_SMOKE_FINAL";

/** Managing-agent prompt requiring installed guidance and capability-safe delegation. */
const smokePrompt = (): string =>
  [
    "Invoke /caara-delegate, then use it to delegate to real Antigravity.",
    "Ask it to inspect package.json read-only and reply exactly CLAUDE_PORTABLE_SMOKE_FINAL.",
    "Surface observationUrl immediately, never open or inspect it, wait until completion, then",
    "return only Antigravity's final answer. Do not modify files.",
  ].join(" ");

/** Claude stream-json content blocks relevant to capability-flow assertions. */
const ClaudeContentBlock = Schema.Struct({
  type: Schema.String,
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Json),
});

/** Claude stream-json envelope relevant to assistant messages and the terminal result. */
const ClaudeStreamEvent = Schema.Struct({
  type: Schema.String,
  message: Schema.optional(Schema.Struct({ content: Schema.Array(ClaudeContentBlock) })),
  result: Schema.optional(Schema.String),
});

/** Decodes every non-empty Claude stream-json event. */
const decodeClaudeEvents = Effect.fnUntraced(function* (source: string) {
  return yield* Effect.forEach(
    source.split("\n").filter((line) => line.length > 0),
    (line) => Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeStreamEvent))(line),
  );
});

/** Runs one real noninteractive Claude managing turn. */
const runRealClaudeSmoke = Effect.fnUntraced(function* () {
  const child = Bun.spawn(
    [
      claudeExecutable,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Bash,Skill",
      "--allowedTools",
      "Bash,Skill(caara-delegate)",
      "--",
      smokePrompt(),
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
  assert.strictEqual(exitCode, 0, stderr);
  return stdout;
});

describe.runIf(realClaudeSmokeEnabled)("installed Claude portable guidance smoke", () => {
  it.live(
    "surfaces the Antigravity viewer without passing its capability to a tool",
    () =>
      Effect.gen(function* () {
        const source = yield* runRealClaudeSmoke();
        const events = yield* decodeClaudeEvents(source);
        const blocks = events.flatMap(({ message }) => message?.content ?? []);
        const toolUses = blocks.filter(({ type }) => type === "tool_use");
        assert.deepStrictEqual(
          toolUses.map(({ name }) => name).filter((name) => name !== "Bash" && name !== "Skill"),
          [],
          "Claude used a non-Bash or native subagent tool",
        );
        const assistantTexts = blocks
          .filter(({ type }) => type === "text")
          .flatMap(({ text }) => Option.toArray(Option.fromUndefinedOr(text)));
        const observationUrl = assistantTexts
          .join("\n")
          .match(/http:\/\/127\.0\.0\.1:\d+\/observe\/[A-Za-z0-9-]+/u)?.[0];
        assert.ok(observationUrl, "Claude did not surface the observation URL in assistant text");
        const urlEventIndex = events.findIndex(({ message }) =>
          message?.content.some(({ text }) => text?.includes(observationUrl) === true),
        );
        const resultEventIndex = events.findLastIndex(({ type }) => type === "result");
        assert.ok(urlEventIndex >= 0 && urlEventIndex < resultEventIndex);
        const terminalResult = events.findLast(({ type }) => type === "result")?.result;
        assert.strictEqual(terminalResult?.trim(), finalMarker());
        const encodedToolInputs = yield* Effect.forEach(
          toolUses.flatMap(({ input }) => Option.toArray(Option.fromUndefinedOr(input))),
          (input) => Schema.encodeEffect(Schema.UnknownFromJsonString)(input),
        );
        const skillInputIndex = toolUses.findIndex(
          ({ input, name }) =>
            name === "Skill" &&
            input !== undefined &&
            Schema.encodeSync(Schema.UnknownFromJsonString)(input).includes("caara-delegate"),
        );
        const firstBashIndex = toolUses.findIndex(({ name }) => name === "Bash");
        assert.ok(skillInputIndex >= 0, "Claude did not invoke the installed caara-delegate skill");
        assert.ok(firstBashIndex < 0 || skillInputIndex < firstBashIndex);
        assert.deepStrictEqual(
          encodedToolInputs.filter((input) => input.includes(observationUrl)),
          [],
          "Claude passed the human observation capability to a tool",
        );
        assert.deepStrictEqual(
          encodedToolInputs.filter((input) =>
            /\/observe\/|curl|wget|browser|open\s+http/iu.test(input),
          ),
          [],
          "Claude attempted to reconstruct or inspect the human viewer",
        );
        assert.strictEqual(/<h1>Agent turn<\/h1>|<h2>Activity<\/h2>/u.test(source), false);
      }),
    300_000,
  );
});
