import { eq } from "drizzle-orm";
import { approvals, deployments } from "@occa/shared/schema";
import type { ContentBlock, DelegatePayload } from "@occa/shared/types";
import { db } from "../../../infra/database/client";
import { createTaskRecord } from "../../../infra/database/task-creation";
import { canDeploy } from "../../agents/services/deployment-hierarchy";

// Side-effect dispatcher — runs after the approval row has flipped.
// Returns the (mutated) approval row so the caller can read the updated
// payload (e.g. spawnedTaskId).
export async function runApprovalSideEffect(
  approval: typeof approvals.$inferSelect,
): Promise<typeof approvals.$inferSelect> {
  switch (approval.actionType) {
    case "delegate":
      return runDelegate(approval);
    case "propose_deployment":
      // No provisioning side effect. A deployment proposal is fulfilled
      // by the operator-signed "Deploy this" flow (the deploy modal),
      // which provisions the agent and then marks this row resolved.
      // Approve here only closes the proposal — it never deploys.
      return approval;
    default:
      // Unknown actionType: no-op. Approve still flips the row.
      return approval;
  }
}

async function runDelegate(
  approval: typeof approvals.$inferSelect,
): Promise<typeof approvals.$inferSelect> {
  const dp = (approval.payload ?? {}) as Partial<DelegatePayload> & {
    spawnedTaskId?: string;
    parentTaskId?: string | null;
  };
  if (
    !dp.targetAgentId ||
    typeof dp.title !== "string" ||
    typeof dp.description !== "string"
  ) {
    throw new Error("delegate_payload_invalid");
  }
  if (!approval.requestedByDeploymentId) {
    throw new Error("delegate_requester_missing");
  }

  // Re-validate scope at decide time — hierarchy could have changed.
  const check = await canDeploy(
    approval.requestedByDeploymentId,
    dp.targetAgentId,
  );
  if (!check.ok) throw new Error(`delegate_scope_invalid:${check.reason}`);

  const [target] = await db
    .select({ id: deployments.id, companyId: deployments.companyId })
    .from(deployments)
    .where(eq(deployments.id, dp.targetAgentId))
    .limit(1);
  if (!target || target.companyId !== approval.companyId) {
    throw new Error("delegate_target_missing");
  }

  const blocks: ContentBlock[] = [
    { type: "paragraph", text: dp.description as string },
  ];
  const newTask = await createTaskRecord({
    companyId: approval.companyId,
    title: dp.title as string,
    blocks,
    status: "todo",
    priority: "medium",
    taskType: "other",
    effortLevel: "m",
    tags: [],
    dueDate: null,
    assignedDeploymentId: dp.targetAgentId,
    parentTaskId: dp.parentTaskId ?? null,
    createdByUserId: null,
    createdByDeploymentId: approval.requestedByDeploymentId,
    acceptanceCriteria: dp.acceptanceCriteria ?? null,
  });

  const [stamped] = await db
    .update(approvals)
    .set({
      payload: { ...dp, spawnedTaskId: newTask.id },
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approval.id))
    .returning();
  return stamped;
}
