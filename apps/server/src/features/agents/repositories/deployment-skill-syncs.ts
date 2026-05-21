import { sql } from "drizzle-orm";
import { deploymentSkillSyncs } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

// Bulk-enqueue install rows for the given (deployment, skillKey) pairs.
// The worker's skill-sync loop picks them up on its next tick.
// Idempotent — uses onConflictDoNothing against the unique
// (deployment_id, skill_key) index.
export async function enqueueInstalls(args: {
  deploymentId: string;
  companyId: string;
  skillKeys: string[];
}): Promise<void> {
  if (args.skillKeys.length === 0) return;
  await db
    .insert(deploymentSkillSyncs)
    .values(
      args.skillKeys.map((key) => ({
        deploymentId: args.deploymentId,
        companyId: args.companyId,
        skillKey: key,
        status: "pending" as const,
        action: "install" as const,
      })),
    )
    .onConflictDoNothing();
}

// Reinstall — used when a tool-generated skill's body changes (sourceRef
// bumped). Upserts: if a row already exists, flips it back to pending +
// reinstall so the worker picks it up again.
export async function enqueueReinstalls(args: {
  deploymentId: string;
  companyId: string;
  skillKeys: string[];
}): Promise<void> {
  if (args.skillKeys.length === 0) return;
  await db
    .insert(deploymentSkillSyncs)
    .values(
      args.skillKeys.map((key) => ({
        deploymentId: args.deploymentId,
        companyId: args.companyId,
        skillKey: key,
        status: "pending" as const,
        action: "reinstall" as const,
      })),
    )
    .onConflictDoUpdate({
      target: [deploymentSkillSyncs.deploymentId, deploymentSkillSyncs.skillKey],
      set: {
        status: "pending",
        action: "reinstall",
        lastError: null,
        updatedAt: sql`now()`,
      },
    });
}

// Uninstall — flips existing install rows to pending uninstall. Inserts a
// fresh uninstall row if none existed (defensive; worker will resolve it
// as a no-op uninstall on the agent side).
export async function enqueueUninstalls(args: {
  deploymentId: string;
  companyId: string;
  skillKeys: string[];
}): Promise<void> {
  if (args.skillKeys.length === 0) return;
  await db
    .insert(deploymentSkillSyncs)
    .values(
      args.skillKeys.map((key) => ({
        deploymentId: args.deploymentId,
        companyId: args.companyId,
        skillKey: key,
        status: "pending" as const,
        action: "uninstall" as const,
      })),
    )
    .onConflictDoUpdate({
      target: [deploymentSkillSyncs.deploymentId, deploymentSkillSyncs.skillKey],
      set: {
        status: "pending",
        action: "uninstall",
        lastError: null,
        updatedAt: sql`now()`,
      },
    });
}
