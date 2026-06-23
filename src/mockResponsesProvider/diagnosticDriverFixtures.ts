/** Stable Diagnostic driver fixtures used by provider, scenario, and session tests. */
export const diagnosticDriverFixture = {
  reasoningText: "diagnostic driver received diagnostic/reasoning",
  basicAnswerText: "Diagnostic basic completed diagnostic/basic",
  resumedBasicAnswerText: "Diagnostic basic resumed prior session with previous target",
  activityReadingText: "Reading src/server.ts",
  activityEditingText: "Editing src/runtimeResponseEncoder.ts",
  activityAnswerText: "Diagnostic activity completed diagnostic/activity",
  startFailureMessage: "diagnostic driver failed before runtime events",
  runtimeFailureBeforeOutputMessage: "diagnostic driver runtime failed before output",
  runtimeFailureAfterPartialMessage: "diagnostic driver runtime failed after partial output",
  unrecoverableSessionFailureMessage:
    "diagnostic driver could not resume prior session or start a fresh external session",
  reasoningItemId: "diagnostic-reasoning",
  basicMessageItemId: "diagnostic-basic-message",
  activityReadingItemId: "diagnostic-activity-reading",
  activityEditingItemId: "diagnostic-activity-editing",
  activityAnswerItemId: "diagnostic-activity-answer",
  echoMessageItemId: "diagnostic-echo-message",
  basicExternalSessionId: "diagnostic-session-codex-thread-diagnostic-basic",
  recoveredExternalSessionId: "diagnostic-session-recovered-codex-thread-diagnostic-basic",
  basicExternalSessionCursor: '{"sessionId":"diagnostic-session-codex-thread-diagnostic-basic"}',
  recoveredExternalSessionCursor:
    '{"sessionId":"diagnostic-session-recovered-codex-thread-diagnostic-basic"}',
} as const;
