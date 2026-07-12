import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import * as z from "zod";

import {
  type CaaraAgentCliError,
  runCaaraAgentCancel,
  runCaaraAgentStart,
  runCaaraAgentWait,
} from "./caaraAgentCli.ts";
import type {
  PortableAgentCancelResult,
  PortableAgentStartResult,
  PortableAgentWaitResult,
} from "./caaraAgentContract.ts";
import type { CaaraSettingsError } from "./caaraSettings.ts";

/** Transport-neutral operations exposed by the blind MCP adapter. */
export interface CaaraAgentMcpOperations {
  readonly start: (input: {
    readonly target: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly driverOptions: Readonly<Record<string, string>>;
    readonly sessionId?: string;
    readonly originMetadata?: Readonly<Record<string, string>>;
  }) => EffectContract<
    typeof PortableAgentStartResult.Type,
    CaaraAgentCliError | CaaraSettingsError
  >;
  readonly wait: (input: {
    readonly turnId: string;
    readonly timeoutMillis?: number;
  }) => EffectContract<
    typeof PortableAgentWaitResult.Type,
    CaaraAgentCliError | CaaraSettingsError
  >;
  readonly cancel: (input: {
    readonly turnId: string;
  }) => EffectContract<
    typeof PortableAgentCancelResult.Type,
    CaaraAgentCliError | CaaraSettingsError
  >;
}

/** Live MCP operations delegating through the installed durable Caara service. */
export const liveCaaraAgentMcpOperations: CaaraAgentMcpOperations = {
  start: (input) => runCaaraAgentStart({ args: [], ...input }),
  wait: (input) => runCaaraAgentWait({ args: [], ...input }),
  cancel: (input) => runCaaraAgentCancel({ args: [], ...input }),
};

/** Shared version field for MCP structured result schemas. */
const versionSchema = z.literal(1);

/** Output schema for accepted portable turns. */
const startOutputSchema = z.object({
  schemaVersion: versionSchema,
  turnId: z.string(),
  sessionId: z.string(),
  status: z.literal("accepted"),
  observationUrl: z.string().min(1),
});

/** Output schema for coarse and terminal wait projections. */
const waitOutputSchema = z.object({
  schemaVersion: versionSchema,
  status: z.enum(["working", "completed", "failed", "cancelled"]),
  turnId: z.string().optional(),
  sessionId: z.string().optional(),
  observationUrl: z.string().min(1).optional(),
  finalAnswer: z.string().optional(),
  outcome: z.enum(["Interrupted", "Abandoned", "Terminated"]).optional(),
  sessionReusable: z.boolean().optional(),
});

/** Output schema for explicit portable cancellation. */
const cancelOutputSchema = z.object({
  schemaVersion: versionSchema,
  status: z.literal("cancelled"),
  outcome: z.enum(["Interrupted", "Abandoned", "Terminated"]),
  sessionReusable: z.boolean(),
});

/** Selects the public MCP error kind for CLI and settings failures. */
const mcpErrorKind = (error: CaaraAgentCliError | CaaraSettingsError) => {
  if ("kind" in error) return error.kind;
  return "invalid_request" as const;
};

/** Encodes one successful structured MCP projection and its text compatibility form. */
const mcpSuccess = Effect.fnUntraced(function* <A extends Record<string, unknown>>(result: A) {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result).pipe(
    Effect.orDie,
  );
  return { content: [{ type: "text" as const, text }], structuredContent: result };
});

/** Encodes one public MCP tool failure without observation-plane detail. */
const mcpFailure = Effect.fnUntraced(function* (error: CaaraAgentCliError | CaaraSettingsError) {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    schemaVersion: 1,
    status: "error",
    error: { kind: mcpErrorKind(error), message: error.message },
  });
  return { content: [{ type: "text" as const, text }], isError: true as const };
});

/** Converts an Effect operation to an MCP structured result without observation-plane data. */
const runTool = <A extends Record<string, unknown>>(
  operation: EffectContract<A, CaaraAgentCliError | CaaraSettingsError>,
): Promise<{
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: A;
  readonly isError?: boolean;
}> => Effect.runPromise(operation.pipe(Effect.flatMap(mcpSuccess), Effect.catch(mcpFailure)));

/** Creates the three-tool MCP server with no resources, prompts, or task support. */
export const createCaaraAgentMcpServer = ({
  operations = liveCaaraAgentMcpOperations,
}: {
  readonly operations?: CaaraAgentMcpOperations;
} = {}): McpServer => {
  const server = new McpServer({ name: "caara-agent", version: "1.0.0" });

  server.registerTool(
    "caara_agent_start",
    {
      description:
        "Start a blind portable Agent turn. Show observationUrl to the human; never open it.",
      inputSchema: z.object({
        target: z.string().min(1),
        cwd: z.string().min(1),
        prompt: z.string().min(1),
        driverOptions: z.record(z.string(), z.string()).default({}),
        sessionId: z.string().min(1).optional(),
        originMetadata: z.record(z.string(), z.string()).optional(),
      }),
      outputSchema: startOutputSchema,
    },
    (input) => runTool(operations.start(input)),
  );

  server.registerTool(
    "caara_agent_wait",
    {
      description: "Wait for a portable Agent turn's coarse or terminal result.",
      inputSchema: z.object({
        turnId: z.string().min(1),
        timeoutMillis: z.number().int().min(0).max(30_000).optional(),
      }),
      outputSchema: waitOutputSchema,
    },
    (input) => runTool(operations.wait(input)),
  );

  server.registerTool(
    "caara_agent_cancel",
    {
      description: "Cancel a portable Agent turn and return its terminal cancellation outcome.",
      inputSchema: z.object({ turnId: z.string().min(1) }),
      outputSchema: cancelOutputSchema,
    },
    (input) => runTool(operations.cancel(input)),
  );

  return server;
};

/** Runs the live Caara Agent MCP server over standard input/output. */
export const runCaaraAgentMcpStdio = Effect.fnUntraced(function* () {
  const server = createCaaraAgentMcpServer();
  yield* Effect.tryPromise(() => server.connect(new StdioServerTransport()));
});
