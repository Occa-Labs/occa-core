// Deployment workspace files — server-rendered markdown templates that
// get pushed to the OpenClaw filesystem at provision time. The DB row
// is the source of truth; the gateway-side files are a downstream copy
// kept in sync via the seedWorkspace RPC.

import { and, eq } from "drizzle-orm";
import { deploymentWorkspaceFiles } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type DeploymentWorkspaceFileRow =
  typeof deploymentWorkspaceFiles.$inferSelect;
export type DeploymentWorkspaceFileInsert =
  typeof deploymentWorkspaceFiles.$inferInsert;

export type DeploymentWorkspaceFileSource =
  | "template"
  | "user_edit"
  | "agent_write";

export async function listForDeployment(
  deploymentId: string,
): Promise<DeploymentWorkspaceFileRow[]> {
  return db
    .select()
    .from(deploymentWorkspaceFiles)
    .where(eq(deploymentWorkspaceFiles.deploymentId, deploymentId));
}

export async function findByName(args: {
  deploymentId: string;
  filename: string;
}): Promise<DeploymentWorkspaceFileRow | null> {
  const [row] = await db
    .select()
    .from(deploymentWorkspaceFiles)
    .where(
      and(
        eq(deploymentWorkspaceFiles.deploymentId, args.deploymentId),
        eq(deploymentWorkspaceFiles.filename, args.filename),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Update content + source for a single file. `syncedAt` lets the caller
// reflect gateway-push outcome: pass a Date on successful push, `null`
// when the local copy is newer than the remote (sync pending).
export async function updateContent(args: {
  deploymentId: string;
  filename: string;
  content: string;
  source: DeploymentWorkspaceFileSource;
  syncedAt: Date | null;
}): Promise<DeploymentWorkspaceFileRow | null> {
  const [row] = await db
    .update(deploymentWorkspaceFiles)
    .set({
      content: args.content,
      source: args.source,
      syncedAt: args.syncedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentWorkspaceFiles.deploymentId, args.deploymentId),
        eq(deploymentWorkspaceFiles.filename, args.filename),
      ),
    )
    .returning();
  return row ?? null;
}

export async function bulkInsert(
  rows: DeploymentWorkspaceFileInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(deploymentWorkspaceFiles).values(rows);
}

// Reprovision overwrites the existing set rather than merging — caller
// passes the full new set, repo replaces atomically.
export async function replaceForDeployment(args: {
  deploymentId: string;
  rows: DeploymentWorkspaceFileInsert[];
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(deploymentWorkspaceFiles)
      .where(eq(deploymentWorkspaceFiles.deploymentId, args.deploymentId));
    if (args.rows.length > 0) {
      await tx.insert(deploymentWorkspaceFiles).values(args.rows);
    }
  });
}

export async function deleteForDeployment(deploymentId: string): Promise<void> {
  await db
    .delete(deploymentWorkspaceFiles)
    .where(eq(deploymentWorkspaceFiles.deploymentId, deploymentId));
}
