import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import * as Path from "effect/Path";

import {
  type DecodedCodexTurnRequest,
  type DecodeCodexTurnRequestOptions,
  decodeCodexTurnRequest,
} from "./codexTurnContext.ts";
import type { InvalidResponsesRequest } from "./errors.ts";

/** Stable project root used as a realistic Codex workspace path in decoder tests. */
const projectRoot = process.cwd();

/** Base turn id used by valid Codex turn metadata fixtures. */
const makeTurnId = (): string => "turn-valid-1";

/** Codex-style user input fixture carried through the decoded Responses request. */
const input = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "inspect cwd" }],
  },
] as const satisfies Schema.Json;

/** Builds Codex turn metadata with optional field overrides. */
const makeTurnMetadata = (
  overrides: Readonly<Record<string, Schema.Json>> = {},
): Readonly<Record<string, Schema.Json>> => ({
  installation_id: "install-1",
  session_id: "parent-session-1",
  thread_id: "codex-thread-1",
  turn_id: makeTurnId(),
  window_id: "window-1",
  request_kind: "turn",
  parent_thread_id: "parent-thread-1",
  subagent_kind: "caara",
  sandbox: "workspace-write",
  workspaces: {
    [projectRoot]: {
      latest_git_commit_hash: "abcdef0",
      has_changes: true,
    },
  },
  turn_started_at_unix_ms: 1,
  ...overrides,
});

/** Builds complete Codex request headers for one turn. */
const makeHeaders = ({
  metadata = makeTurnMetadata(),
  overrides = {},
}: {
  readonly metadata?: Readonly<Record<string, Schema.Json>>;
  readonly overrides?: Readonly<Record<string, string>>;
} = {}): Readonly<Record<string, string>> => ({
  "session-id": "parent-session-1",
  "thread-id": "codex-thread-1",
  "x-client-request-id": makeTurnId(),
  "x-codex-parent-thread-id": "parent-thread-1",
  "x-codex-turn-metadata": Schema.encodeSync(Schema.UnknownFromJsonString)(metadata),
  "x-codex-window-id": "window-1",
  "x-openai-subagent": "caara",
  originator: "codex_cli_rs",
  ...overrides,
});

/** Builds a valid streaming Responses request body with Codex client metadata. */
const makeBody = (
  overrides: Readonly<Record<string, Schema.Json>> = {},
): Readonly<Record<string, Schema.Json>> => ({
  model: "claude/test",
  input,
  stream: true,
  client_metadata: {
    thread_id: "codex-thread-1",
    turn_id: makeTurnId(),
  },
  metadata: {
    cwd: projectRoot,
  },
  ...overrides,
});

/** Path service that treats workspace-scheme paths as absolute for decoder seam tests. */
const workspaceSchemePathService: Path.Path = {
  [Path.TypeId]: Path.TypeId,
  sep: "/",
  basename: (value) => value.split("/").at(-1) ?? value,
  dirname: (value) => value.split("/").slice(0, -1).join("/") || "/",
  extname: () => "",
  format: (pathObject) => `${pathObject.dir ?? ""}/${pathObject.name ?? ""}${pathObject.ext ?? ""}`,
  fromFileUrl: (url) => Effect.succeed(url.href),
  isAbsolute: (value) => value.startsWith("workspace:"),
  join: (...segments) => segments.join("/"),
  normalize: (value) => value,
  parse: (value) => ({
    root: "",
    dir: "",
    base: value,
    ext: "",
    name: value,
  }),
  relative: (_from, to) => to,
  resolve: (...segments) => segments.join("/"),
  toFileUrl: (value) => Effect.succeed(new URL(`file://${value}`)),
  toNamespacedPath: (value) => value,
};

/** Test layer proving the decoder consumes Path from the Effect environment. */
const workspaceSchemePathLayer = Layer.succeed(Path.Path, workspaceSchemePathService);

/** Decodes with the default POSIX path service used by decoder unit tests. */
const decodeWithDefaultPath = (options: DecodeCodexTurnRequestOptions) =>
  decodeCodexTurnRequest(options).pipe(Effect.provide(Path.layer));

/** Extracts the invalid request message from an expected decoder failure result. */
const invalidRequestMessageFromResult = (
  result: Result.Result<DecodedCodexTurnRequest, InvalidResponsesRequest>,
): string => {
  const failure = Result.match(result, {
    onFailure: (error) => error,
    onSuccess: () => assert.fail("decodeCodexTurnRequest unexpectedly succeeded"),
  });
  assert.strictEqual(failure._tag, "InvalidResponsesRequest");
  return failure.message;
};

describe("Codex turn context decoder", () => {
  it.effect("decodes Codex turn context, agent target, driver options, and cwd candidates", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWithDefaultPath({
        headers: makeHeaders(),
        url: "/v1/responses?effort=max&allowed_tools=Read",
        body: makeBody(),
        requireCwd: true,
      });

      assert.strictEqual(decoded.codex.parentSessionId, "parent-session-1");
      assert.strictEqual(decoded.codex.threadId, "codex-thread-1");
      assert.strictEqual(decoded.codex.turnId, makeTurnId());
      assert.strictEqual(decoded.codex.windowId, "window-1");
      assert.strictEqual(decoded.codex.parentThreadId, "parent-thread-1");
      assert.strictEqual(decoded.codex.subagentKind, "caara");
      assert.strictEqual(decoded.target.requestedModel, "claude/test");
      assert.strictEqual(decoded.target.externalAgentKind, "claude");
      assert.strictEqual(decoded.target.externalModelSpecifier, "test");
      assert.deepStrictEqual(decoded.target.rawDriverOptions, {
        effort: "max",
        allowed_tools: "Read",
      });
      assert.deepStrictEqual(decoded.codex.workspacePaths, [projectRoot]);
      assert.deepStrictEqual(decoded.codex.cwdCandidates, [projectRoot]);
      assert.deepStrictEqual(decoded.responses.input, input);
    }),
  );

  it.effect("filters workspace paths through the injected Path service", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeCodexTurnRequest({
        headers: makeHeaders({
          metadata: makeTurnMetadata({
            workspaces: {
              "workspace:/project": {
                latest_git_commit_hash: "abcdef0",
                has_changes: true,
              },
              [projectRoot]: {
                latest_git_commit_hash: "abcdef0",
                has_changes: true,
              },
            },
          }),
        }),
        url: "/v1/responses",
        body: makeBody({ metadata: {} }),
        requireCwd: true,
      }).pipe(Effect.provide(workspaceSchemePathLayer));

      assert.deepStrictEqual(decoded.codex.workspacePaths, ["workspace:/project"]);
      assert.deepStrictEqual(decoded.codex.cwdCandidates, []);
    }),
  );

  it.effect("rejects malformed model strings", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeWithDefaultPath({
          headers: makeHeaders(),
          url: "/v1/responses",
          body: makeBody({ model: "claude" }),
          requireCwd: true,
        }),
      );
      const message = invalidRequestMessageFromResult(result);

      assert.match(message, /model/i);
    }),
  );

  it.effect("accepts open lowercase external agent kinds before registry resolution", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWithDefaultPath({
        headers: makeHeaders(),
        url: "/v1/responses",
        body: makeBody({ model: "gemini/pro" }),
        requireCwd: true,
      });

      assert.strictEqual(decoded.target.requestedModel, "gemini/pro");
      assert.strictEqual(decoded.target.externalAgentKind, "gemini");
      assert.strictEqual(decoded.target.externalModelSpecifier, "pro");
    }),
  );

  it.effect("rejects malformed external agent kind syntax", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeWithDefaultPath({
          headers: makeHeaders(),
          url: "/v1/responses",
          body: makeBody({ model: "Gemini/pro" }),
          requireCwd: true,
        }),
      );
      const message = invalidRequestMessageFromResult(result);

      assert.match(message, /lowercase slug/i);
    }),
  );

  it.effect("rejects duplicate provider query params", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeWithDefaultPath({
          headers: makeHeaders(),
          url: "/v1/responses?effort=max&effort=low",
          body: makeBody(),
          requireCwd: true,
        }),
      );
      const message = invalidRequestMessageFromResult(result);

      assert.match(message, /duplicate provider query param/i);
    }),
  );

  it.effect("rejects malformed Codex turn metadata", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeWithDefaultPath({
          headers: makeHeaders({
            overrides: { "x-codex-turn-metadata": "{not-json" },
          }),
          url: "/v1/responses",
          body: makeBody(),
          requireCwd: true,
        }),
      );
      const message = invalidRequestMessageFromResult(result);

      assert.match(message, /turn metadata/i);
    }),
  );

  it.effect("rejects conflicting identity fields", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decodeWithDefaultPath({
          headers: makeHeaders({
            overrides: { "thread-id": "different-thread" },
          }),
          url: "/v1/responses",
          body: makeBody(),
          requireCwd: true,
        }),
      );
      const message = invalidRequestMessageFromResult(result);

      assert.match(message, /conflict/i);
    }),
  );

  it.effect("allows observed Codex subagent header and metadata kind to differ", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWithDefaultPath({
        headers: makeHeaders({
          metadata: makeTurnMetadata({ subagent_kind: "thread_spawn" }),
          overrides: { "x-openai-subagent": "collab_spawn" },
        }),
        url: "/v1/responses",
        body: makeBody(),
        requireCwd: true,
      });

      assert.strictEqual(decoded.codex.subagentKind, "thread_spawn");
      assert.strictEqual(decoded.target.requestedModel, "claude/test");
    }),
  );

  it.effect("requires cwd for new external code-agent bindings", () =>
    Effect.gen(function* () {
      const metadataWithoutWorkspace = makeTurnMetadata({ workspaces: {} });
      const result = yield* Effect.result(
        decodeWithDefaultPath({
          headers: makeHeaders({ metadata: metadataWithoutWorkspace }),
          url: "/v1/responses",
          body: makeBody({ metadata: {} }),
          requireCwd: true,
        }),
      );
      const message = invalidRequestMessageFromResult(result);

      assert.match(message, /cwd/i);
    }),
  );

  it.effect("allows missing cwd when an existing binding can provide it later", () =>
    Effect.gen(function* () {
      const metadataWithoutWorkspace = makeTurnMetadata({ workspaces: {} });
      const decoded = yield* decodeWithDefaultPath({
        headers: makeHeaders({ metadata: metadataWithoutWorkspace }),
        url: "/v1/responses",
        body: makeBody({ metadata: {} }),
        requireCwd: false,
      });

      assert.deepStrictEqual(decoded.codex.workspacePaths, []);
      assert.deepStrictEqual(decoded.codex.cwdCandidates, []);
    }),
  );
});
