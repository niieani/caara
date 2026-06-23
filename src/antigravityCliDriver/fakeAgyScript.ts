/** Fake Antigravity transcript fixture values shared by process script and assertions. */
export const fakeAgyFixture = {
  conversationId: "9c59875d-eb16-4436-9c52-d27da2c60a91",
  recoveredConversationId: "9c59875d-eb16-4436-9c52-d27da2c60a92",
  finalAnswer: "agy transcript final answer",
  resumedAnswer: "agy resumed transcript final answer",
  recoveredAnswer: "agy recovered transcript final answer",
} as const;

/** Bun executable fixture that simulates the Antigravity CLI transcript/log contract. */
export const fakeAgyScript = `#!/usr/bin/env bun
import * as fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args.at(index + 1);
};
const logFile = valueAfter("--log-file");
const prompt = valueAfter("--prompt") ?? "";
const conversationArg = valueAfter("--conversation");
const invocationLog = process.env.AGY_FAKE_INVOCATION_LOG;
const mode = process.env.AGY_FAKE_MODE ?? "success";
const freshRecovery = mode === "resume-rejected" || mode === "fresh-recovery-success";
const conversationId = conversationArg ?? (freshRecovery ? "${fakeAgyFixture.recoveredConversationId}" : "${fakeAgyFixture.conversationId}");

if (!invocationLog) {
  process.stderr.write("missing invocation log");
  process.exit(70);
}

fs.mkdirSync(path.dirname(invocationLog), { recursive: true });
fs.appendFileSync(invocationLog, JSON.stringify({ cwd: process.cwd(), args, prompt }) + "\\n");

if (mode === "process-failure") {
  process.stderr.write("fake agy failed");
  process.exit(23);
}

if (mode === "resume-rejected" && conversationArg) {
  process.stderr.write("fake agy rejected resume");
  process.exit(31);
}

if (mode === "fresh-recovery-failure" && !conversationArg) {
  process.stderr.write("fake agy fresh recovery failed");
  process.exit(42);
}

if (mode !== "missing-log" && logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, "I0622 20:09:01.708030 server.go:789] Created conversation " + conversationId + "\\n");
}

if (mode !== "missing-transcript") {
  const transcriptPath = path.join(process.env.HOME ?? "", ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  const legacyTranscriptPath = path.join(process.env.HOME ?? "", ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  if (mode === "transcript-jsonl-only") {
    fs.mkdirSync(path.dirname(legacyTranscriptPath), { recursive: true });
    fs.writeFileSync(legacyTranscriptPath, JSON.stringify({ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "legacy transcript answer" }) + "\\n");
    process.stdout.write("stdout also must not become the answer\\n");
    process.exit(0);
  }
  if (conversationArg && mode === "resume-success") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const records = [
      { step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "${fakeAgyFixture.resumedAnswer}" },
    ];
    fs.appendFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    process.stdout.write("stdout must not become the answer\\n");
    process.exit(0);
  }
  if (conversationArg && mode === "resume-missing-final") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const records = [
      { step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 4, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-06-23T03:10:01Z" },
    ];
    fs.appendFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    process.stdout.write("stdout must not become the answer\\n");
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const records = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
    { step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", created_at: "2026-06-23T03:09:01Z" },
  ];
  if (mode !== "missing-final") {
    records.push({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: freshRecovery ? "${fakeAgyFixture.recoveredAnswer}" : "${fakeAgyFixture.finalAnswer}" });
  }
  fs.writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
}

process.stdout.write("stdout must not become the answer\\n");
`;
