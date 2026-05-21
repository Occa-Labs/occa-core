// MCP handler — generic JSON-RPC client for Model Context Protocol
// servers over HTTP. Used by catalog entries with
// `implementation.kind === "mcp"`.
//
// MCP defines (among others) two RPC methods:
//
//   - tools/list  → returns the action set the server exposes
//   - tools/call  → invokes one action with arguments
//
// For v1 OCCA supports HTTP transport only. The server URL is either
// fixed in the catalog entry or supplied per-install via the tool's
// metadata field.

import { z } from "zod";
import type {
  CatalogEntry,
  CatalogImplementation,
} from "../domain/catalog-schemas";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let nextRpcId = 1;

export interface McpEndpointConfig {
  url: string;
  authHeader?: string;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpInvokeOutcome {
  ok: boolean;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  rateLimited?: boolean;
}

// Resolve the MCP endpoint config from a catalog entry's implementation
// block + the installed tool's credentials/metadata. Throws if the entry
// is not MCP-backed or the URL can't be resolved.
export function resolveMcpEndpoint(args: {
  impl: CatalogImplementation;
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): McpEndpointConfig {
  if (args.impl.kind !== "mcp") {
    throw new Error(
      `resolveMcpEndpoint: implementation kind is ${args.impl.kind}, not mcp`,
    );
  }
  let url: string;
  if (args.impl.url === "dynamic") {
    const field = args.impl.urlMetadataField ?? "url";
    const raw = args.metadata[field];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(
        `MCP endpoint URL missing from metadata.${field}`,
      );
    }
    url = raw;
  } else {
    url = args.impl.url;
  }
  const authHeader =
    typeof args.credentials.authHeader === "string" &&
    args.credentials.authHeader.length > 0
      ? args.credentials.authHeader
      : undefined;
  return { url, authHeader };
}

async function callRpc(
  cfg: McpEndpointConfig,
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: nextRpcId++,
    method,
    ...(params ? { params } : {}),
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (cfg.authHeader) headers.Authorization = cfg.authHeader;
  const res = await fetch(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new Error(
      `MCP server returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok && !parsed.error) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return parsed;
}

const mcpToolListResult = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export async function listMcpTools(
  cfg: McpEndpointConfig,
): Promise<McpToolDescriptor[]> {
  const res = await callRpc(cfg, "tools/list");
  if (res.error) {
    throw new Error(`MCP tools/list error: ${res.error.message}`);
  }
  const parsed = mcpToolListResult.safeParse(res.result);
  if (!parsed.success) {
    throw new Error(
      `MCP tools/list returned unexpected shape: ${JSON.stringify(
        parsed.error.flatten(),
      )}`,
    );
  }
  return parsed.data.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }));
}

export async function callMcpTool(args: {
  cfg: McpEndpointConfig;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<McpInvokeOutcome> {
  let res: JsonRpcResponse;
  try {
    res = await callRpc(args.cfg, "tools/call", {
      name: args.toolName,
      arguments: args.arguments,
    });
  } catch (err) {
    return {
      ok: false,
      errorCode: "mcp_network_error",
      errorMessage: err instanceof Error ? err.message : "MCP request failed",
    };
  }
  if (res.error) {
    return {
      ok: false,
      errorCode: `mcp_rpc_${res.error.code}`,
      errorMessage: res.error.message,
    };
  }
  return { ok: true, output: res.result };
}

// Best-effort connection check. Uses tools/list as a liveness probe —
// if the server responds with a valid tool list, it's reachable and
// authenticated correctly. For URL-dynamic catalogs (custom MCP), this
// is the only honest validation OCCA can perform pre-install.
export async function testMcpConnection(
  entry: CatalogEntry,
  credentials: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Promise<
  | { ok: true; detail?: string }
  | { ok: false; errorCode: string; errorMessage: string }
> {
  let cfg: McpEndpointConfig;
  try {
    cfg = resolveMcpEndpoint({ impl: entry.implementation, credentials, metadata });
  } catch (err) {
    return {
      ok: false,
      errorCode: "mcp_config_invalid",
      errorMessage: err instanceof Error ? err.message : "config invalid",
    };
  }
  try {
    const tools = await listMcpTools(cfg);
    return {
      ok: true,
      detail: `Connected. ${tools.length} tool${tools.length === 1 ? "" : "s"} available.`,
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: "mcp_unreachable",
      errorMessage: err instanceof Error ? err.message : "MCP unreachable",
    };
  }
}
