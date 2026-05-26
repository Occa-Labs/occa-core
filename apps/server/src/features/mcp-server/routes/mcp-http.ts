// OCCA-as-MCP-server: exposes a subset of OCCA tools to external MCP
// clients (Hermes Agent today; potentially other runtimes later).
//
// Phase 1b: hardcoded synthetic `system_echo` tool, no catalog wiring,
// no per-agent tool filtering. Validates the transport works end-to-end.
// Phase 1c swaps the hardcoded tool for catalog-driven dispatch.
//
// Transport: Streamable HTTP from the official @modelcontextprotocol/sdk.
// Stateless mode — each request spins up a fresh transport + server,
// closed when the response finishes. Cheap because there's no agent
// state on the OCCA side per MCP session yet.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  listTasksInputSchema,
  listTasksTool,
} from "../services/builtin-tools";

function buildServer(agentId: string): McpServer {
  const server = new McpServer({
    name: "occa-tools",
    version: "0.1.0",
  });

  // Phase 1b smoke tool — kept around for transport sanity-checking.
  // Safe to remove once we have enough real tools to smoke against.
  server.registerTool(
    "system_echo",
    {
      description:
        "Echo back the input text, prefixed with the OCCA agent id. " +
        "Synthetic Phase 1b tool — proves the OCCA MCP server is reachable " +
        "and that a tool round-trips through the transport. Has no side effects.",
      inputSchema: {
        text: z.string().min(1).max(500).describe("Text to echo back"),
      },
    },
    async ({ text }) => ({
      content: [
        {
          type: "text" as const,
          text: `[echo from OCCA agent ${agentId}] ${text}`,
        },
      ],
    }),
  );

  // Phase 1c first real tool: list tasks for a company. Read-only,
  // safe to call without auth scoping (Phase 1c uses any-bearer auth;
  // agent scoping lands in 1c+).
  server.registerTool(
    "occa_list_tasks",
    {
      description:
        "List tasks in an OCCA company, ordered by most-recently-updated. " +
        "Returns id, taskNumber, title, status, assignedDeploymentId, " +
        "parentTaskId, updatedAt for each task. Use this to see what's on " +
        "a team's plate before deciding what to delegate or pick up next.",
      inputSchema: listTasksInputSchema,
    },
    async (input) => {
      const result = await listTasksTool(input);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

export const mcpRouter: Router = Router();

mcpRouter.post("/agents/:agentId", async (req: Request, res: Response) => {
  const auth = req.header("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }
  // Phase 1b: accept any non-empty bearer token. Phase 1c validates
  // against the per-trace agent API key, scoping the call to a real
  // OCCA agent identity.
  const token = auth.slice(7).trim();
  if (token.length === 0) {
    res.status(401).json({ error: "empty_bearer_token" });
    return;
  }

  const agentId = req.params.agentId;
  if (!agentId || agentId.length > 64) {
    res.status(400).json({ error: "invalid_agent_id" });
    return;
  }

  const server = buildServer(agentId);
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session resumption. Each request is independent.
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        error: "mcp_internal",
        message: err instanceof Error ? err.message : "unknown",
      });
    }
  }
});
