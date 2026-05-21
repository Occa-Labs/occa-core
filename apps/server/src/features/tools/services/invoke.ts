// Tool invocation service — dispatches a tool call to the right backend.
//
// The catalog entry's `implementation.kind` decides where to route:
//
//   - "embedded" → in-process handler (handlers/<name>.ts).
//     Used today for `x` (OAuth 1.0a signer). The handler owns its
//     Zod schemas for input + output and the actual API call.
//
//   - "mcp" → external MCP server over JSON-RPC.
//     Action set comes from the server's `tools/list`. Validation is
//     best-effort; the MCP server enforces its own input schema and
//     we surface its error verbatim.
//
// Either path goes through the same audit log + outcome envelope, so
// the agent-facing endpoint stays uniform.

import {
  decryptCredentials,
  type EncryptedBlob,
} from "../../../lib/tool-crypto";
import { findOwnedById as findOwnedToolById } from "../repositories/company-tools";
import { insert as insertCallLog } from "../repositories/tool-call-logs";
import { findCatalogEntry } from "./catalog-loader";
import { findEmbeddedHandler } from "../handlers/embedded-handlers";
import {
  callMcpTool,
  listMcpTools,
  resolveMcpEndpoint,
} from "../handlers/mcp";
import type { ToolInvokeContext } from "../domain/types";
import { childLogger } from "../../../lib/logger";

const log = childLogger("services:tool-invoke");

export type InvokeOutcome =
  | { kind: "ok"; output: unknown; latencyMs: number }
  | {
      kind: "not_found";
      reason: "tool_not_found" | "tool_type_unknown" | "tool_action_not_found";
    }
  | {
      kind: "rejected";
      reason: "tool_paused" | "invalid_input" | "invalid_credentials";
      detail?: unknown;
    }
  | {
      kind: "failed";
      errorCode: string;
      errorMessage: string;
      rateLimited?: boolean;
    };

export async function invokeTool(args: {
  toolId: string;
  actionName: string;
  companyId: string;
  deploymentId: string | null;
  input: Record<string, unknown>;
}): Promise<InvokeOutcome> {
  const started = Date.now();

  const tool = await findOwnedToolById({
    id: args.toolId,
    companyId: args.companyId,
  });
  if (!tool) return { kind: "not_found", reason: "tool_not_found" };
  if (tool.status === "paused") {
    return { kind: "rejected", reason: "tool_paused" };
  }

  const entry = await findCatalogEntry(tool.type);
  if (!entry) return { kind: "not_found", reason: "tool_type_unknown" };

  let credentials: Record<string, unknown>;
  try {
    credentials = decryptCredentials<Record<string, unknown>>(
      tool.credentialsEncrypted as EncryptedBlob,
    );
  } catch (err) {
    log.error({ err, toolId: tool.id }, "invoke: decrypt failed");
    return {
      kind: "rejected",
      reason: "invalid_credentials",
      detail: err instanceof Error ? err.message : "decrypt failed",
    };
  }

  const metadata = (tool.metadata as Record<string, unknown>) ?? {};

  if (entry.implementation.kind === "embedded") {
    return invokeEmbedded({
      ...args,
      tool,
      metadata,
      credentials,
      handlerName: entry.implementation.handler,
      started,
    });
  }
  return invokeMcp({
    ...args,
    tool,
    entry,
    metadata,
    credentials,
    started,
  });
}

// ── embedded dispatch ──────────────────────────────────────────────────

async function invokeEmbedded(args: {
  toolId: string;
  actionName: string;
  companyId: string;
  deploymentId: string | null;
  input: Record<string, unknown>;
  tool: Awaited<ReturnType<typeof findOwnedToolById>>;
  metadata: Record<string, unknown>;
  credentials: Record<string, unknown>;
  handlerName: string;
  started: number;
}): Promise<InvokeOutcome> {
  if (!args.tool) return { kind: "not_found", reason: "tool_not_found" };
  const handler = findEmbeddedHandler(args.handlerName);
  if (!handler) {
    log.error(
      { handlerName: args.handlerName, toolId: args.tool.id },
      "invoke: embedded handler not registered",
    );
    return { kind: "not_found", reason: "tool_type_unknown" };
  }

  const credResult = handler.credentialsSchema.safeParse(args.credentials);
  if (!credResult.success) {
    return { kind: "rejected", reason: "invalid_credentials" };
  }

  const actions = handler.actions ?? {};
  const action = actions[args.actionName];
  if (!action) return { kind: "not_found", reason: "tool_action_not_found" };

  const inputResult = action.inputSchema.safeParse(args.input);
  if (!inputResult.success) {
    return {
      kind: "rejected",
      reason: "invalid_input",
      detail: inputResult.error.flatten(),
    };
  }

  const ctx: ToolInvokeContext = {
    credentials: credResult.data,
    metadata: args.metadata,
    companyId: args.companyId,
    toolId: args.tool.id,
    deploymentId: args.deploymentId,
  };

  let result;
  try {
    result = await action.invoke(ctx, inputResult.data);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "embedded handler threw";
    log.warn(
      { err, toolId: args.tool.id, action: args.actionName },
      "invoke: embedded handler threw",
    );
    await insertCallLog({
      companyId: args.companyId,
      toolId: args.tool.id,
      deploymentId: args.deploymentId,
      action: args.actionName,
      status: "failed",
      errorCode: "handler_threw",
      errorMessage,
      latencyMs: Date.now() - args.started,
    });
    return { kind: "failed", errorCode: "handler_threw", errorMessage };
  }

  const latencyMs = Date.now() - args.started;

  if (!result.ok) {
    await insertCallLog({
      companyId: args.companyId,
      toolId: args.tool.id,
      deploymentId: args.deploymentId,
      action: args.actionName,
      status: result.rateLimited ? "rate_limited" : "failed",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      latencyMs,
    });
    return {
      kind: "failed",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      rateLimited: result.rateLimited,
    };
  }

  const outputResult = action.outputSchema.safeParse(result.output);
  if (!outputResult.success) {
    const errorMessage =
      "Handler returned output that does not match outputSchema.";
    log.error(
      {
        toolId: args.tool.id,
        action: args.actionName,
        issues: outputResult.error.flatten(),
      },
      "invoke: output validation failed",
    );
    await insertCallLog({
      companyId: args.companyId,
      toolId: args.tool.id,
      deploymentId: args.deploymentId,
      action: args.actionName,
      status: "failed",
      errorCode: "invalid_output_shape",
      errorMessage,
      latencyMs,
    });
    return { kind: "failed", errorCode: "invalid_output_shape", errorMessage };
  }

  await insertCallLog({
    companyId: args.companyId,
    toolId: args.tool.id,
    deploymentId: args.deploymentId,
    action: args.actionName,
    status: "success",
    resultSummary:
      (result.resultSummary as Record<string, unknown> | undefined) ??
      (outputResult.data && typeof outputResult.data === "object"
        ? (outputResult.data as Record<string, unknown>)
        : null),
    latencyMs,
  });

  return { kind: "ok", output: outputResult.data, latencyMs };
}

// ── MCP dispatch ───────────────────────────────────────────────────────

async function invokeMcp(args: {
  toolId: string;
  actionName: string;
  companyId: string;
  deploymentId: string | null;
  input: Record<string, unknown>;
  tool: Awaited<ReturnType<typeof findOwnedToolById>>;
  entry: Awaited<ReturnType<typeof findCatalogEntry>>;
  metadata: Record<string, unknown>;
  credentials: Record<string, unknown>;
  started: number;
}): Promise<InvokeOutcome> {
  if (!args.tool || !args.entry) {
    return { kind: "not_found", reason: "tool_not_found" };
  }

  let cfg;
  try {
    cfg = resolveMcpEndpoint({
      impl: args.entry.implementation,
      credentials: args.credentials,
      metadata: args.metadata,
    });
  } catch (err) {
    return {
      kind: "rejected",
      reason: "invalid_credentials",
      detail: err instanceof Error ? err.message : "MCP config invalid",
    };
  }

  // Verify the action exists on the MCP server before sending. Cheap
  // round-trip but produces clearer error messages and prevents the
  // agent from blindly calling a missing tool.
  try {
    const tools = await listMcpTools(cfg);
    if (!tools.some((t) => t.name === args.actionName)) {
      return { kind: "not_found", reason: "tool_action_not_found" };
    }
  } catch (err) {
    return {
      kind: "failed",
      errorCode: "mcp_unreachable",
      errorMessage:
        err instanceof Error ? err.message : "MCP tools/list failed",
    };
  }

  const result = await callMcpTool({
    cfg,
    toolName: args.actionName,
    arguments: args.input,
  });

  const latencyMs = Date.now() - args.started;

  if (!result.ok) {
    await insertCallLog({
      companyId: args.companyId,
      toolId: args.tool.id,
      deploymentId: args.deploymentId,
      action: args.actionName,
      status: result.rateLimited ? "rate_limited" : "failed",
      errorCode: result.errorCode ?? "mcp_error",
      errorMessage: result.errorMessage ?? "MCP call failed",
      latencyMs,
    });
    return {
      kind: "failed",
      errorCode: result.errorCode ?? "mcp_error",
      errorMessage: result.errorMessage ?? "MCP call failed",
      rateLimited: result.rateLimited,
    };
  }

  await insertCallLog({
    companyId: args.companyId,
    toolId: args.tool.id,
    deploymentId: args.deploymentId,
    action: args.actionName,
    status: "success",
    resultSummary:
      result.output && typeof result.output === "object"
        ? (result.output as Record<string, unknown>)
        : null,
    latencyMs,
  });

  return { kind: "ok", output: result.output, latencyMs };
}
