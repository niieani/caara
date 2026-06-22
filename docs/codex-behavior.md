# Codex Behavior

Observed Codex Desktop behavior when spawning a Caara-backed subagent through the OpenAI
Responses-compatible transport.

Source artifact: `temp.local/2026-06-21/caara-smoke.log`

The raw log is intentionally not copied here: it is large, includes the full prompt/instruction
stack, and contains opaque attestation material. The artifacts below preserve the observable fields
Codex sends when it runs subagents through the Responses-compatible transport.

## Smoke Run

Caara was run locally on `127.0.0.1:8787`.

Three real Codex subagent requests were captured:

1. First spawned `caara` subagent, first turn.
2. Second spawned `caara` subagent, first turn.
3. Second spawned `caara` subagent, follow-up turn on the same subagent handle.

All three returned the current mock assistant output:

```text
Yes, the mock subagent seems to be working
```

## Request Envelope

Codex calls Caara with `POST /v1/responses` and `stream: true`.

Observed top-level body keys:

```json
[
  "client_metadata",
  "include",
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "prompt_cache_key",
  "reasoning",
  "store",
  "stream",
  "tool_choice",
  "tools"
]
```

Important headers:

```json
{
  "accept": "text/event-stream",
  "authorization": "[redacted]",
  "content-type": "application/json",
  "originator": "Codex Desktop",
  "session-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
  "thread-id": "019eee10-3ec3-7203-ba12-df284337c152",
  "x-client-request-id": "019eee10-3ec3-7203-ba12-df284337c152",
  "x-codex-parent-thread-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
  "x-codex-turn-metadata": "{\"installation_id\":\"...\",\"session_id\":\"...\",\"thread_id\":\"...\",\"turn_id\":\"...\"}",
  "x-codex-window-id": "019eee10-3ec3-7203-ba12-df284337c152:0",
  "x-openai-subagent": "collab_spawn"
}
```

`client_metadata` repeats the Codex-specific routing headers inside the request body.

## Model Field

Codex sends the selected custom agent model as body `model`.

Observed on 2026-06-22:

- `.codex/agents/caara.toml` set `model = "fake-model"`.
- Caara received `"model": "fake-model"` in the request body.
- A `spawn_agent` call with explicit override `model = "gpt-5.4-mini"` was accepted by the tool,
  but the Caara request body still contained `"model": "fake-model"` for the pinned `caara` role.

Meaning: the custom agent file model is observable in the request body. The observed runtime
override did not replace the pinned custom-agent model.

## Captured Artifacts

### Artifact 1: First Subagent, First Turn

```json
{
  "headers": {
    "session-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "thread-id": "019eee0f-abc9-75d1-ada3-9a7889723a0e",
    "x-client-request-id": "019eee0f-abc9-75d1-ada3-9a7889723a0e",
    "x-codex-parent-thread-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "x-codex-window-id": "019eee0f-abc9-75d1-ada3-9a7889723a0e:0",
    "x-openai-subagent": "collab_spawn"
  },
  "turnMetadata": {
    "installation_id": "7fba043a-aaec-4307-8091-302916f13d57",
    "session_id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "thread_id": "019eee0f-abc9-75d1-ada3-9a7889723a0e",
    "turn_id": "019eee0f-ae1a-7d33-ac43-b2233d59a016",
    "window_id": "019eee0f-abc9-75d1-ada3-9a7889723a0e:0",
    "request_kind": "turn",
    "parent_thread_id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "subagent_kind": "thread_spawn",
    "sandbox": "none",
    "workspaces": {
      "/Volumes/Projects/Software/code-agents-as-responses-api": {
        "latest_git_commit_hash": "75720d9b60ca329f9f502d7caebfeb4d5ccad779",
        "has_changes": true
      }
    },
    "turn_started_at_unix_ms": 1782110465565
  },
  "body": {
    "model": "fake-model",
    "stream": true,
    "store": false,
    "input_items": 3,
    "instructions_length": 20771
  },
  "cwdCandidates": ["/Volumes/Projects/Software/code-agents-as-responses-api"]
}
```

### Artifact 2: Second Subagent, First Turn

```json
{
  "headers": {
    "session-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "thread-id": "019eee10-3ec3-7203-ba12-df284337c152",
    "x-client-request-id": "019eee10-3ec3-7203-ba12-df284337c152",
    "x-codex-parent-thread-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "x-codex-window-id": "019eee10-3ec3-7203-ba12-df284337c152:0",
    "x-openai-subagent": "collab_spawn"
  },
  "turnMetadata": {
    "installation_id": "7fba043a-aaec-4307-8091-302916f13d57",
    "session_id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "thread_id": "019eee10-3ec3-7203-ba12-df284337c152",
    "turn_id": "019eee10-40f5-7431-b4cf-8567ca2b985b",
    "window_id": "019eee10-3ec3-7203-ba12-df284337c152:0",
    "request_kind": "turn",
    "parent_thread_id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "subagent_kind": "thread_spawn",
    "sandbox": "none",
    "workspaces": {
      "/Volumes/Projects/Software/code-agents-as-responses-api": {
        "latest_git_commit_hash": "75720d9b60ca329f9f502d7caebfeb4d5ccad779",
        "has_changes": true
      }
    },
    "turn_started_at_unix_ms": 1782110503159
  },
  "body": {
    "model": "fake-model",
    "stream": true,
    "store": false,
    "input_items": 3
  },
  "cwdCandidates": ["/Volumes/Projects/Software/code-agents-as-responses-api"]
}
```

### Artifact 3: Second Subagent, Follow-Up Turn

```json
{
  "headers": {
    "session-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "thread-id": "019eee10-3ec3-7203-ba12-df284337c152",
    "x-client-request-id": "019eee10-3ec3-7203-ba12-df284337c152",
    "x-codex-parent-thread-id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "x-codex-window-id": "019eee10-3ec3-7203-ba12-df284337c152:0",
    "x-openai-subagent": "collab_spawn"
  },
  "turnMetadata": {
    "installation_id": "7fba043a-aaec-4307-8091-302916f13d57",
    "session_id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "thread_id": "019eee10-3ec3-7203-ba12-df284337c152",
    "turn_id": "019eee10-5a69-78d2-90f1-5cad63f9fa34",
    "window_id": "019eee10-3ec3-7203-ba12-df284337c152:0",
    "request_kind": "turn",
    "parent_thread_id": "019eedf5-5a56-7eb2-a210-4846a6409ede",
    "subagent_kind": "thread_spawn",
    "sandbox": "none",
    "turn_started_at_unix_ms": 1782110509749
  },
  "body": {
    "model": "fake-model",
    "stream": true,
    "store": false,
    "input_items": 5
  },
  "cwdCandidates": ["/Volumes/Projects/Software/code-agents-as-responses-api"]
}
```

## Meaning

`thread-id` is the stable Codex subagent identity.

- New subagent handles get new `thread-id` values.
- Follow-up turns on the same subagent reuse the same `thread-id`.
- `x-client-request-id` matched `thread-id` in all observed requests.
- `client_metadata.thread_id` matched the header `thread-id`.

`turn_id` is the per-turn identity.

- It changed on every prompt, including follow-up prompts on an existing subagent.

`session-id` is the managing Codex session identity.

- It stayed the same across different spawned subagents.
- `x-codex-parent-thread-id` matched `session-id`.

`x-codex-window-id` is stable across turns within one subagent window.

- It had the shape `${thread_id}:0`.

Working directory can arrive from two places.

- First turns included `x-codex-turn-metadata.workspaces`.
- Follow-up turn metadata omitted `workspaces`.
- The request body still contained cwd context in the prompt stack, and the diagnostic extractor
  found the same path.

## Open Questions

- Does Codex ever send `previous_response_id` for subagent turns? It was absent in observed
  requests.
- Does `x-client-request-id` always equal `thread-id`, or can it become per-turn in other Codex
  versions?
- Does Codex send an explicit close/cancel request for subagents through this transport, or does
  Caara need idle reaping only?
