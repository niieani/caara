import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Match, Stream } from "effect";

import {
  codexCliArgv,
  codexCliEnvironment,
  createCodexCliClient,
  type CodexCliProcess,
} from "./client.ts";
import type { CodexCliInvocation } from "./driver.ts";

/** Canonical invocation used by focused Codex process-boundary tests. */
const invocation: CodexCliInvocation = {
  cwd: "/worktree",
  model: "gpt-5.6",
  prompt: "inspect",
  lineage: ["codex"],
  depth: 1,
};

/** Controllable process fixture exposing JSONL and exit boundaries independently. */
const makeProcess = () => {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const killed: NodeJS.Signals[] = [];
  const encoder = new TextEncoder();
  const process: CodexCliProcess = {
    stdout: new ReadableStream<Uint8Array>({
      start: (controller) => {
        stdoutController = controller;
      },
    }),
    stderrText: () => Promise.resolve("fatal diagnostic"),
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
    kill: (signal) => {
      killed.push(signal);
      resolveExit?.(143);
      stdoutController?.close();
    },
  };
  return {
    process,
    killed,
    emit: (record: string) => stdoutController?.enqueue(encoder.encode(`${record}\n`)),
    emitRaw: (line: string) => stdoutController?.enqueue(encoder.encode(`${line}\n`)),
    exit: (code: number) => {
      stdoutController?.close();
      resolveExit?.(code);
    },
  };
};

describe("Codex CLI client", () => {
  it("builds fresh and resumed JSONL argv", () => {
    assert.deepStrictEqual(codexCliArgv(invocation), [
      "exec",
      "--json",
      "--model",
      "gpt-5.6",
      "--cd",
      "/worktree",
      "inspect",
    ]);
    assert.deepStrictEqual(codexCliArgv({ ...invocation, resumeSessionId: "thread-1" }), [
      "exec",
      "resume",
      "--json",
      "--model",
      "gpt-5.6",
      "thread-1",
      "inspect",
    ]);
    assert.deepStrictEqual(codexCliEnvironment(invocation), {
      CAARA_DELEGATION_LINEAGE: "codex",
      CAARA_DELEGATION_DEPTH: "1",
    });
  });

  it.effect("returns at thread.started and streams later activity before process exit", () =>
    Effect.gen(function* () {
      const fixture = makeProcess();
      const client = createCodexCliClient({ spawn: () => fixture.process });
      const starting = yield* Effect.forkChild(client.start(invocation));
      fixture.emit('{"type":"thread.started","thread_id":"thread-1"}');
      const running = yield* Fiber.join(starting);
      assert.strictEqual(running.sessionId, "thread-1");

      const collecting = yield* Effect.forkChild(Stream.runCollect(running.runtimeEvents));
      fixture.emit('{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}');
      fixture.emit('{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}');
      fixture.emit('{"type":"turn.completed"}');
      fixture.exit(0);

      assert.deepStrictEqual(Array.from(yield* Fiber.join(collecting)), [
        { _tag: "Reasoning", text: "thinking" },
        { _tag: "Assistant", text: "answer" },
        { _tag: "Succeeded" },
      ]);
    }),
  );

  it.effect("terminates an in-flight process conservatively on cancellation", () =>
    Effect.gen(function* () {
      const fixture = makeProcess();
      const client = createCodexCliClient({ spawn: () => fixture.process });
      const starting = yield* Effect.forkChild(client.start(invocation));
      fixture.emit('{"type":"thread.started","thread_id":"thread-1"}');
      const running = yield* Fiber.join(starting);

      assert.deepStrictEqual(yield* running.cancel, {
        _tag: "Terminated",
        sessionReusable: false,
      });
      assert.deepStrictEqual(fixture.killed, ["SIGTERM"]);
    }),
  );

  it.effect("reports unavailable executable and malformed startup JSONL explicitly", () =>
    Effect.gen(function* () {
      const unavailable = createCodexCliClient({
        spawn: () => {
          throw new Error("ENOENT");
        },
      });
      const unavailableResult = yield* Effect.result(unavailable.start(invocation));
      assert.strictEqual(unavailableResult._tag, "Failure");
      assert.match(
        Match.valueTags(unavailableResult, {
          Failure: ({ failure }) => failure.message,
          Success: () => "",
        }),
        /failed to start.*ENOENT/iu,
      );

      const fixture = makeProcess();
      const malformed = createCodexCliClient({ spawn: () => fixture.process });
      const starting = yield* Effect.forkChild(malformed.start(invocation));
      fixture.emitRaw("not-json");
      const malformedResult = yield* Effect.result(Fiber.join(starting));
      assert.strictEqual(malformedResult._tag, "Failure");
      assert.match(
        Match.valueTags(malformedResult, {
          Failure: ({ failure }) => failure.message,
          Success: () => "",
        }),
        /malformed JSONL/iu,
      );
    }),
  );

  it.effect("surfaces nonzero process exit diagnostics while awaiting startup", () =>
    Effect.gen(function* () {
      const fixture = makeProcess();
      const client = createCodexCliClient({ spawn: () => fixture.process });
      const starting = yield* Effect.forkChild(client.start(invocation));
      fixture.exit(7);
      const result = yield* Effect.result(Fiber.join(starting));
      assert.strictEqual(result._tag, "Failure");
      assert.match(
        Match.valueTags(result, {
          Failure: ({ failure }) => failure.message,
          Success: () => "",
        }),
        /code 7.*fatal diagnostic/iu,
      );
    }),
  );
});
