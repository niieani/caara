/** Fake Antigravity transcript fixture values shared by process script and assertions. */
export const fakeAgyFixture = {
  conversationId: "9c59875d-eb16-4436-9c52-d27da2c60a91",
  recoveredConversationId: "9c59875d-eb16-4436-9c52-d27da2c60a92",
  finalAnswer: "agy transcript final answer",
  resumedAnswer: "agy resumed transcript final answer",
  recoveredAnswer: "agy recovered transcript final answer",
  reasoningText: "agy transcript reasoning summary",
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

const appendSignalLog = (signal) => {
  fs.appendFileSync(invocationLog, JSON.stringify({ event: "signal", signal, mode }) + "\\n");
};

process.on("SIGTERM", () => {
  appendSignalLog("SIGTERM");
  process.exit(0);
});

process.on("SIGINT", () => {
  appendSignalLog("SIGINT");
  process.exit(0);
});

const waitForCancellation = () => {
  setInterval(() => undefined, 1000);
  return new Promise(() => undefined);
};

const delay = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

const waitForFile = async (filePath) => {
  while (!fs.existsSync(filePath)) {
    await delay(10);
  }
};

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
  if (mode === "cancel-before-transcript") {
    await waitForCancellation();
  }
  if (mode === "cancel-after-transcript") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const records = [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "partial cancelled answer" },
    ];
    fs.writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    await waitForCancellation();
  }
  if (mode === "cancel-during-activity") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const records = [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "Inspecting workspace", tool_calls: [{ id: "tool-call-list", name: "list_dir", args: { DirectoryPath: "src", toolAction: "Listing src directory", toolSummary: "Src directory listing" } }] },
      { step_index: 2, source: "MODEL", type: "VIEW_FILE", status: "DONE", created_at: "2026-06-23T03:09:01Z", file_path: "src/server.ts", content: "FULL_FILE_CONTENT_SHOULD_NOT_LEAK" },
    ];
    fs.writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n" + "{\\"step_index\\":3");
    await waitForCancellation();
  }
  if (mode === "streaming-activity-before-exit") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const records = [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "Inspecting workspace", tool_calls: [{ id: "tool-call-list", name: "list_dir", args: { DirectoryPath: "src", toolAction: "Listing src directory", toolSummary: "Src directory listing" } }] },
    ];
    fs.writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    await waitForCancellation();
  }
  if (mode === "streaming-out-of-order-before-exit") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const partialRecords = [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 2, source: "MODEL", type: "LIST_DIRECTORY", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "RAW_OUT_OF_ORDER_DIRECTORY_SHOULD_NOT_LEAK" },
    ];
    fs.writeFileSync(transcriptPath, partialRecords.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    fs.appendFileSync(invocationLog, JSON.stringify({ event: "out_of_order_partial", mode }) + "\\n");
    const continuePath = path.join(process.env.HOME ?? "", ".caara", "antigravity-cli", "continue-out-of-order");
    await waitForFile(continuePath);
    const remainingRecords = [
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "Listing source", tool_calls: [{ id: "tool-call-list", name: "list_dir", args: { DirectoryPath: "src", toolAction: "Listing src directory", toolSummary: "Src directory listing" } }] },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:02Z", thinking: "out-of-order live reasoning", content: "out-of-order live final" },
    ];
    fs.appendFileSync(transcriptPath, remainingRecords.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    fs.appendFileSync(invocationLog, JSON.stringify({ event: "out_of_order_complete", mode }) + "\\n");
    process.exit(0);
  }
  if (conversationArg && (mode === "resume-success" || mode === "portable-success")) {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const resumedUserStep = mode === "portable-success" ? 5 : 3;
    const resumedAnswerStep = mode === "portable-success" ? 6 : 4;
    const records = [
      { step_index: resumedUserStep, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: resumedAnswerStep, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "${fakeAgyFixture.resumedAnswer}" },
    ];
    fs.appendFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    process.stdout.write("stdout must not become the answer\\n");
    process.exit(0);
  }
  if (conversationArg && mode === "resume-cancel-after-transcript") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const records = [
      { step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "partial resumed cancelled answer" },
    ];
    fs.appendFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    await delay(500);
    process.exit(0);
  }
  if (conversationArg && mode === "portable-cancel-resume") {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const records = [
      { step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "<USER_REQUEST>\\\\n" + prompt + "\\\\n</USER_REQUEST>" },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:10:01Z", content: "Inspecting workspace", tool_calls: [{ id: "tool-call-list", name: "list_dir", args: { DirectoryPath: "src", toolAction: "Listing src directory", toolSummary: "Src directory listing" } }] },
    ];
    fs.appendFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    await waitForCancellation();
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
  if (mode === "reasoning-activity" || mode === "portable-success") {
    records.push(
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "Inspecting workspace", tool_calls: [{ id: "tool-call-list", name: "list_dir", args: { DirectoryPath: "src", toolAction: "Listing src directory", toolSummary: "Src directory listing" }, payload: "FULL_TOOL_PAYLOAD_SHOULD_NOT_LEAK" }] },
      { step_index: 3, source: "MODEL", type: "VIEW_FILE", status: "DONE", created_at: "2026-06-23T03:09:01Z", file_path: "src/server.ts", content: "FULL_FILE_CONTENT_SHOULD_NOT_LEAK" },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", thinking: "${fakeAgyFixture.reasoningText}", content: "${fakeAgyFixture.finalAnswer}" },
    );
  } else if (mode === "tool-only-missing-final") {
    records.push(
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "Inspecting workspace", tool_calls: [{ id: "tool-call-list", name: "list_dir", args: { DirectoryPath: "src", toolAction: "Listing src directory", toolSummary: "Src directory listing" } }] },
      { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: "RAW_TOOL_ONLY_RESULT_SHOULD_NOT_LEAK" },
    );
  } else if (mode !== "missing-final") {
    records.push({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-23T03:09:01Z", content: freshRecovery ? "${fakeAgyFixture.recoveredAnswer}" : "${fakeAgyFixture.finalAnswer}" });
  }
  fs.writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n");
}

process.stdout.write("stdout must not become the answer\\n");
`;
