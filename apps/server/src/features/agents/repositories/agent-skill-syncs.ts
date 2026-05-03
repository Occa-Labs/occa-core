import { agentSkillSyncs } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

// Bulk-enqueue install rows for the given (agent, skillKey) pairs. The
// worker's skill-sync loop picks them up on its next tick. Idempotent —
// uses onConflictDoNothing against the unique (agent_id, skill_key) index.
export async function enqueueInstalls(args: {
  agentId: string;
  companyId: string;
  skillKeys: string[];
}): Promise<void> {
  if (args.skillKeys.length === 0) return;
  await db
    .insert(agentSkillSyncs)
    .values(
      args.skillKeys.map((key) => ({
        agentId: args.agentId,
        companyId: args.companyId,
        skillKey: key,
        status: "pending" as const,
        action: "install" as const,
      })),
    )
    .onConflictDoNothing();
}
