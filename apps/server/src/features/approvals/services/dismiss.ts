// Dismiss an approval — the operator clears a pending row from the queue
// without an approve/reject decision. Sets the (previously unused)
// "cancelled" terminal status; runs NO side effects and requires NO reason.
//
// Distinct from reject: reject is an explicit denial that records a reason
// (which the requesting agent may consume), whereas dismiss is a quiet
// "this is moot, clear it" — useful for stale CEO-authored proposals the
// operator doesn't want to formally deny. Like decide, it is scoped by
// companyId (a caller can only act on its own company's rows) and only
// touches pending rows. There is intentionally no channel/Telegram path:
// dismiss is OS-only.

import { and, eq } from "drizzle-orm";
import { approvals } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";

type ApprovalRow = typeof approvals.$inferSelect;

export type DismissApprovalResult =
  | { kind: "ok"; approval: ApprovalRow }
  | { kind: "not_found" }
  | { kind: "already_decided" };

export interface DismissApprovalInput {
  approvalId: string;
  companyId: string;
  dismissedByUserId: string;
}

export async function dismissApproval(
  input: DismissApprovalInput,
): Promise<DismissApprovalResult> {
  // Scope by companyId so a caller can never dismiss another company's row.
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (!row) return { kind: "not_found" };
  if (row.status !== "pending") return { kind: "already_decided" };

  // Reuse decidedAt/decidedByUserId for "who/when closed it" — dismiss is a
  // terminal close like decide, just without a positive/negative verdict, so
  // a dedicated cancelledAt/By column would only duplicate those semantics.
  const now = new Date();
  const [updated] = await db
    .update(approvals)
    .set({
      status: "cancelled",
      decidedAt: now,
      decidedByUserId: input.dismissedByUserId,
      updatedAt: now,
    })
    .where(eq(approvals.id, row.id))
    .returning();
  return { kind: "ok", approval: updated };
}
