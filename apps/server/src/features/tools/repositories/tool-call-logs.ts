// Tool call logs — append-only audit log of tool invocations.
//
// One row per invocation. Indexed for "recent activity per company" and
// "recent activity per tool" listings. Result summary capped at the
// route layer; this repository accepts whatever the caller passes.

import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { toolCallLogs } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type ToolCallLogRow = typeof toolCallLogs.$inferSelect;
export type ToolCallLogInsert = typeof toolCallLogs.$inferInsert;

export type ToolCallStatus = "success" | "failed" | "rate_limited";

export async function insert(args: {
  companyId: string;
  toolId: string;
  deploymentId: string | null;
  action: string;
  status: ToolCallStatus;
  resultSummary?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
}): Promise<ToolCallLogRow> {
  const [row] = await db
    .insert(toolCallLogs)
    .values({
      companyId: args.companyId,
      toolId: args.toolId,
      deploymentId: args.deploymentId,
      action: args.action,
      status: args.status,
      resultSummary: args.resultSummary ?? null,
      errorCode: args.errorCode ?? null,
      errorMessage: args.errorMessage ?? null,
      latencyMs: args.latencyMs ?? null,
    })
    .returning();
  return row;
}

export async function listForTool(args: {
  toolId: string;
  companyId: string;
  limit?: number;
  before?: Date;
}): Promise<ToolCallLogRow[]> {
  const conditions: SQL[] = [
    eq(toolCallLogs.toolId, args.toolId),
    eq(toolCallLogs.companyId, args.companyId),
  ];
  if (args.before) {
    conditions.push(lt(toolCallLogs.createdAt, args.before));
  }
  return db
    .select()
    .from(toolCallLogs)
    .where(and(...conditions))
    .orderBy(desc(toolCallLogs.createdAt))
    .limit(args.limit ?? 50);
}

export async function listForCompany(args: {
  companyId: string;
  limit?: number;
  before?: Date;
}): Promise<ToolCallLogRow[]> {
  const conditions: SQL[] = [eq(toolCallLogs.companyId, args.companyId)];
  if (args.before) {
    conditions.push(lt(toolCallLogs.createdAt, args.before));
  }
  return db
    .select()
    .from(toolCallLogs)
    .where(and(...conditions))
    .orderBy(desc(toolCallLogs.createdAt))
    .limit(args.limit ?? 100);
}
