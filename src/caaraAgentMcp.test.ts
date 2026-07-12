import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect, Schema } from "effect";
import * as z from "zod";

import { CaaraAgentCliError } from "./caaraAgentCli.ts";
import type { CaaraAgentMcpOperations } from "./caaraAgentMcp.ts";
import { createCaaraAgentMcpServer } from "./caaraAgentMcp.ts";
import { PortableSessionId, PortableTurnId } from "./portableAgentIdentity.ts";

const turnId = PortableTurnId.make("portable-turn-00000000-0000-4000-8000-000000000001");
const sessionId = PortableSessionId.make("portable-session-mcp-contract");
/** Records MCP operation inputs while returning blindness-safe portable projections. */
const operations = ({ calls }: { readonly calls: string[] }): CaaraAgentMcpOperations => ({
  start: (input) => {
    calls.push(`start:${input.sessionId ?? "new"}:PRIVATE_DIAGNOSTIC_ACTIVITY_SENTINEL`);
    return Effect.succeed({
      schemaVersion: 1,
      turnId,
      sessionId,
      status: "accepted",
      observationUrl: "http://127.0.0.1:8787/observe/private-capability",
    });
  },
  wait: ({ turnId: selected }) => {
    calls.push(`wait:${selected}:PRIVATE_DIAGNOSTIC_ACTIVITY_SENTINEL`);
    return Effect.succeed({ schemaVersion: 1, status: "completed", finalAnswer: "public answer" });
  },
  cancel: ({ turnId: selected }) => {
    calls.push(`cancel:${selected}:PRIVATE_DIAGNOSTIC_ACTIVITY_SENTINEL`);
    return Effect.succeed({
      schemaVersion: 1,
      status: "cancelled",
      outcome: "Interrupted",
      sessionReusable: true,
    });
  },
});

/** Runs one assertion against a fully initialized in-memory MCP connection. */
const withClient = Effect.fnUntraced(function* (
  use: (client: Client) => Promise<void>,
  selectedOperations?: CaaraAgentMcpOperations,
) {
  const calls: string[] = [];
  const server = createCaaraAgentMcpServer({
    operations: selectedOperations ?? operations({ calls }),
  });
  const client = new Client({ name: "caara-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  yield* Effect.tryPromise(() => server.connect(serverTransport));
  yield* Effect.tryPromise(() => client.connect(clientTransport));
  yield* Effect.tryPromise(() => use(client));
  yield* Effect.tryPromise(() => client.close());
  yield* Effect.tryPromise(() => server.close());
  return calls;
});

describe("Caara Agent MCP", () => {
  it.effect("discovers only typed blind delegation tools and no resources", () =>
    withClient((client) =>
      client.listTools().then((tools) => {
        assert.deepStrictEqual(
          tools.tools.map(({ name }) => name),
          ["caara_agent_start", "caara_agent_wait", "caara_agent_cancel"],
        );
        assert.strictEqual(client.getServerCapabilities()?.resources, undefined);
        assert.strictEqual(client.getServerCapabilities()?.prompts, undefined);
        const discovered = tools.tools
          .flatMap(({ name, description }) => [name, description ?? ""])
          .join("\n");
        assert.notMatch(discovered, /transcript|runtime.?event|relay.?log|observation.?read/iu);
        assert.notMatch(discovered, /PRIVATE_DIAGNOSTIC/iu);
        assert.deepStrictEqual(
          tools.tools.map(({ execution }) => execution?.taskSupport),
          ["forbidden", "forbidden", "forbidden"],
        );
      }),
    ),
  );

  it.effect("starts, resumes, waits, and cancels through durable portable handles", () =>
    withClient((client) =>
      client
        .callTool({
          name: "caara_agent_start",
          arguments: {
            target: "claude/sonnet",
            cwd: "/workspace",
            prompt: "delegate",
            driverOptions: {},
            sessionId,
          },
        })
        .then((started) => {
          assert.deepStrictEqual(started.structuredContent, {
            schemaVersion: 1,
            turnId,
            sessionId,
            status: "accepted",
            observationUrl: "http://127.0.0.1:8787/observe/private-capability",
          });
          return client
            .callTool({ name: "caara_agent_wait", arguments: { turnId } })
            .then((waited) => ({ started, waited }));
        })
        .then(({ started, waited }) => {
          assert.deepStrictEqual(waited.structuredContent, {
            schemaVersion: 1,
            status: "completed",
            finalAnswer: "public answer",
          });
          return client
            .callTool({ name: "caara_agent_cancel", arguments: { turnId } })
            .then((cancelled) => ({ started, waited, cancelled }));
        })
        .then(({ started, waited, cancelled }) => {
          assert.deepStrictEqual(cancelled.structuredContent, {
            schemaVersion: 1,
            status: "cancelled",
            outcome: "Interrupted",
            sessionReusable: true,
          });
        }),
    ).pipe(
      Effect.tap((calls) =>
        Effect.sync(() => {
          assert.match(calls[0] ?? "", new RegExp(`start:${sessionId}`, "u"));
        }),
      ),
    ),
  );

  it.effect("returns typed tool failures without diagnostic activity", () =>
    withClient(
      (client) =>
        client.callTool({ name: "caara_agent_wait", arguments: { turnId } }).then((result) => {
          const parsed = z
            .object({
              isError: z.literal(true),
              content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
            })
            .parse(result);
          assert.deepStrictEqual(
            Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
              parsed.content[0]?.text ?? "",
            ),
            {
              schemaVersion: 1,
              status: "error",
              error: { kind: "unknown_resource", message: "Portable turn not found." },
            },
          );
          assert.notMatch(
            parsed.content.map(({ text }) => text).join("\n"),
            /PRIVATE_DIAGNOSTIC_ACTIVITY_SENTINEL/u,
          );
        }),
      {
        start: operations({ calls: [] }).start,
        wait: () =>
          Effect.fail(
            new CaaraAgentCliError({
              kind: "unknown_resource",
              message: "Portable turn not found.",
            }),
          ),
        cancel: operations({ calls: [] }).cancel,
      },
    ),
  );
});
