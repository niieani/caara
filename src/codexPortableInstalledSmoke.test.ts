import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

/** Explicit opt-in preventing normal tests from invoking Codex, credentials, or user services. */
const realCodexSmokeEnabled = process.env.CAARA_REAL_CODEX_PORTABLE_SMOKE === "1";

/** Codex executable selected by the operator running the installed smoke. */
const codexExecutable = process.env.CAARA_SMOKE_CODEX_EXECUTABLE ?? "codex";

/** Stable final marker requested from the real delegated Claude turn. */
const finalMarker = (): string => "CODEX_PORTABLE_SMOKE_FINAL";

/** Managing-agent prompt that requires installed portable guidance and forbids viewer inspection. */
const smokePrompt = (): string =>
  [
    "Delegate to a real Claude target using Caara's installed portable blind-delegation guidance.",
    "Ask Claude to inspect package.json read-only and reply exactly CODEX_PORTABLE_SMOKE_FINAL.",
    "Surface observationUrl immediately, never open or inspect it, wait until completion, then",
    "return only Claude's final answer. Do not modify files.",
  ].join(" ");

/** Codex exec JSONL item fields needed to distinguish messages from actual tool inputs. */
const CodexExecItem = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Json),
  query: Schema.optional(Schema.String),
});

/** Codex exec JSONL event envelope used by the opt-in installed smoke. */
const CodexExecEvent = Schema.Struct({
  type: Schema.String,
  item: Schema.optional(CodexExecItem),
});

/** Decodes every non-empty Codex JSONL event through the explicit smoke schema. */
const decodeCodexExecEvents = Effect.fnUntraced(function* (source: string) {
  return yield* Effect.forEach(
    source.split("\n").filter((line) => line.length > 0),
    (line) => Schema.decodeUnknownEffect(Schema.fromJsonString(CodexExecEvent))(line),
  );
});

/** Runs one real Codex managing turn and captures its JSONL event stream. */
const runRealCodexSmoke = Effect.fnUntraced(function* () {
  const child = Bun.spawn(
    [
      codexExecutable,
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--cd",
      process.cwd(),
      smokePrompt(),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
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

describe.runIf(realCodexSmokeEnabled)("installed Codex portable guidance smoke", () => {
  it.live(
    "surfaces the Claude viewer without passing its capability to a tool",
    () =>
      Effect.gen(function* () {
        const source = yield* runRealCodexSmoke();
        const events = yield* decodeCodexExecEvents(source);
        const items = events.flatMap(({ item }) => Option.toArray(Option.fromUndefinedOr(item)));
        const agentMessages = items
          .filter((item) => item.type === "agent_message")
          .flatMap(({ text }) => Option.toArray(Option.fromUndefinedOr(text)));
        const urlMessageIndex = agentMessages.findIndex((text) =>
          /http:\/\/127\.0\.0\.1:\d+\/observe\/[A-Za-z0-9-]+/u.test(text),
        );
        assert.ok(urlMessageIndex >= 0, "Codex did not surface the observation URL in a message");
        const observationUrl = (agentMessages.at(urlMessageIndex) ?? "").match(
          /http:\/\/127\.0\.0\.1:\d+\/observe\/[A-Za-z0-9-]+/u,
        )?.[0];
        assert.ok(observationUrl);
        const finalMessageIndex = agentMessages.length - 1;
        assert.ok(finalMessageIndex > urlMessageIndex, "Codex emitted no later terminal message");
        assert.strictEqual(agentMessages.at(finalMessageIndex)?.trim(), finalMarker());
        const argumentInputs = yield* Effect.forEach(
          items
            .map(({ arguments: input }) => input)
            .filter((input): input is Schema.Json => input !== undefined),
          (input) => Schema.encodeEffect(Schema.UnknownFromJsonString)(input),
        );
        const toolInputs = items
          .flatMap(({ command, query }) => [command, query])
          .filter((input): input is string => input !== undefined);
        assert.deepStrictEqual(
          [...toolInputs, ...argumentInputs].filter((input) => input.includes(observationUrl)),
          [],
          "Codex passed the human observation capability to a tool",
        );
        assert.strictEqual(/<h1>Agent turn<\/h1>|<h2>Activity<\/h2>/u.test(source), false);
      }),
    300_000,
  );
});
