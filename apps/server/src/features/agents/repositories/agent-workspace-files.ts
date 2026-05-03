// Agent workspace files — server-rendered markdown templates that get
// pushed to the OpenClaw filesystem at provision time. The DB row is
// the source of truth; the gateway-side files are a downstream copy
// kept in sync via the seedWorkspace RPC.

import { eq } from "drizzle-orm";
import { agentWorkspaceFiles } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type AgentWorkspaceFileRow = typeof agentWorkspaceFiles.$inferSelect;
export type AgentWorkspaceFileInsert = typeof agentWorkspaceFiles.$inferInsert;

export async function listForAgent(
  agentId: string,
): Promise<AgentWorkspaceFileRow[]> {
  return db
    .select()
    .from(agentWorkspaceFiles)
    .where(eq(agentWorkspaceFiles.agentId, agentId));
}

export async function bulkInsert(
  rows: AgentWorkspaceFileInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(agentWorkspaceFiles).values(rows);
}

// Reprovision overwrites the existing set rather than merging — caller
// passes the full new set, repo replaces atomically.
export async function replaceForAgent(args: {
  agentId: string;
  rows: AgentWorkspaceFileInsert[];
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(agentWorkspaceFiles)
      .where(eq(agentWorkspaceFiles.agentId, args.agentId));
    if (args.rows.length > 0) {
      await tx.insert(agentWorkspaceFiles).values(args.rows);
    }
  });
}

export async function deleteForAgent(agentId: string): Promise<void> {
  await db
    .delete(agentWorkspaceFiles)
    .where(eq(agentWorkspaceFiles.agentId, agentId));
}
