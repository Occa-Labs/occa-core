// Approval post-create hook — fans out side concerns (notification emit,
// future audit log, etc.) so create-sites stay focused on the insert
// itself. Fire-and-forget from caller's perspective: emit errors are
// logged but never propagate (an approval that exists with no
// notification is degraded, not broken — operator can still see it in
// the Approvals window).

import { eq } from "drizzle-orm";
import { approvals, companies } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { emitNotification } from "../../notifications/services/emit";
import { channelActionsForApproval } from "../domain/channel-actions";

const log = childLogger("services:approvals:post-create");

export async function notifyApprovalCreated(
  approval: typeof approvals.$inferSelect,
): Promise<void> {
  try {
    const [company] = await db
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, approval.companyId))
      .limit(1);
    if (!company?.ownerUserId) {
      log.warn(
        { approvalId: approval.id, companyId: approval.companyId },
        "no owner user for company — skip notification",
      );
      return;
    }
    await emitNotification({
      companyId: approval.companyId,
      userId: company.ownerUserId,
      kind: "approval_pending",
      title: titleForApproval(approval.actionType),
      body: null,
      payload: {
        approvalId: approval.id,
        actionType: approval.actionType,
      },
      link: `approvals:${approval.id}`,
      // Channel-decidable approvals (delegate, profile edit) get one-tap
      // approve/reject buttons; OS-only ones (propose_deployment) get none.
      actions: channelActionsForApproval(approval.id, approval.actionType),
    });
  } catch (err) {
    log.error(
      { err, approvalId: approval.id },
      "approval notification emit failed",
    );
  }
}

function titleForApproval(actionType: string): string {
  switch (actionType) {
    case "delegate":
      return "Agent requests to delegate a task";
    case "propose_deployment":
      return "CEO proposes deploying an agent";
    default:
      return "Approval requested";
  }
}
