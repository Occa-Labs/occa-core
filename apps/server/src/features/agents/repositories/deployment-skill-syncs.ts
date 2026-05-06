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
