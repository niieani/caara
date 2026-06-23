import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  CaaraSessionBinding,
  DurableExternalSession,
  makeApiResponseId,
  makeCodexParentSessionId,
  makeCodexThreadId,
  makeCodexTurnId,
  makeDriverInstanceId,
  makeDriverResumeCursor,
  makeExternalAgentKind,
  makeExternalModelSpecifier,
  makeRequestedModelSpecifier,
  SessionDirectory,
} from "./sessionDirectory.ts";
import {
  SessionDirectoryConfigError,
  sessionBindingFilePath,
  sessionDirectoryFromEnvironmentLive,
  sessionDirectoryLive,
} from "./sessionDirectoryPlatform.ts";

/** Stable fake state directory used by platform-service tests. */
const stateDir = (): "/virtual-caara-state" => "/virtual-caara-state";

/** Stable binding key used by platform-service tests. */
const bindingKey = {
  externalAgentKind: makeExternalAgentKind("claude"),
  driverInstanceId: makeDriverInstanceId("claude"),
  codexThreadId: makeCodexThreadId("codex-thread-platform-services"),
};

/** Stored binding fixture encoded through the production schema. */
const binding = new CaaraSessionBinding({
  schemaVersion: 2,
  apiResponseId: makeApiResponseId("resp_platform-services"),
  bindingKey,
  parentCodexSessionId: makeCodexParentSessionId("parent-platform-services"),
  requestedTarget: {
    requestedModel: makeRequestedModelSpecifier("claude/sonnet"),
    externalModelSpecifier: makeExternalModelSpecifier("sonnet"),
    rawDriverOptions: {},
  },
  externalSession: new DurableExternalSession({
    driverResumeCursor: makeDriverResumeCursor("sdk-session-platform-services"),
  }),
  cwd: "/workspace/project",
  createdFromTurnId: makeCodexTurnId("turn-platform-services-created"),
  lastTurnId: makeCodexTurnId("turn-platform-services-latest"),
});

/** JSON payload returned by the injected fake FileSystem. */
const encodedBinding = Schema.encodeSync(Schema.UnknownFromJsonString)(binding);

/** Builds the environment-backed session directory layer with an empty env fixture. */
const emptyEnvironmentSessionDirectoryLayer = () =>
  sessionDirectoryFromEnvironmentLive({
    env: {},
  }).pipe(Layer.provideMerge(FileSystem.layerNoop({})), Layer.provideMerge(Path.layer));

/** Extracts a config error from an expected failed layer construction. */
const configErrorMessage = (result: Result.Result<unknown, unknown>): string => {
  const failure = Result.match(result, {
    onFailure: (error) => error,
    onSuccess: () => assert.fail("expected session directory config failure"),
  });
  assert.ok(failure instanceof SessionDirectoryConfigError);
  return failure.message;
};

describe("session directory platform services", () => {
  it.effect("loads bindings through the injected FileSystem service", () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const expectedFilePath = sessionBindingFilePath({ stateDir: stateDir(), ...bindingKey });
      const directoryLayer = sessionDirectoryLive({ stateDir: stateDir() }).pipe(
        Layer.provideMerge(
          FileSystem.layerNoop({
            exists: (filePath) => Effect.sync(() => (operations.push(`exists:${filePath}`), true)),
            readFileString: (filePath) =>
              Effect.sync(() => (operations.push(`read:${filePath}`), encodedBinding)),
          }),
        ),
        Layer.provideMerge(Path.layer),
      );

      const directory = yield* SessionDirectory.pipe(Effect.provide(directoryLayer));
      const loaded = yield* directory.get(bindingKey);

      assert.deepStrictEqual(operations, [
        `exists:${expectedFilePath}`,
        `read:${expectedFilePath}`,
      ]);
      assert.deepStrictEqual(Option.getOrUndefined(loaded), binding);
    }),
  );

  it.effect("fails live state-dir resolution when no state env root is configured", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        SessionDirectory.pipe(Effect.provide(emptyEnvironmentSessionDirectoryLayer())),
      );

      assert.match(configErrorMessage(result), /CAARA_STATE_DIR|XDG_STATE_HOME|HOME/);
    }),
  );
});
