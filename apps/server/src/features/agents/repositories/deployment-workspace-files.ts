// Deployment workspace files — server-rendered markdown templates that
// get pushed to the OpenClaw filesystem at provision time. The DB row
// is the source of truth; the gateway-side files are a downstream copy
// kept in sync via the seedWorkspace RPC.

import { eq } from "drizzle-orm";
import { deploymentWorkspaceFiles } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

export type DeploymentWorkspaceFileRow =
  typeof deploymentWorkspaceFiles.$inferSelect;
export type DeploymentWorkspaceFileInsert =
  typeof deploymentWorkspaceFiles.$inferInsert;

export async function listForDeployment(
  deploymentId: string,
): Promise<DeploymentWorkspaceFileRow[]> {
  return db
    .select()
    .from(deploymentWorkspaceFiles)
    .where(eq(deploymentWorkspaceFiles.deploymentId, deploymentId));
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
