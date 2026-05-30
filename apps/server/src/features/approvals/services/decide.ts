// Decide an approval — the core flip-row → run-side-effect → enqueue
// pipeline, extracted from the HTTP route so non-HTTP callers (channel
// transports such as the Telegram inline-button handler) decide through
// the exact same path instead of duplicating it. Scope is enforced by
// companyId: a caller can only decide approvals belonging to its own
// company. HTTP-shaped concerns (status codes, "reject needs a reason"
// form rule) stay in the route; this service speaks results, not HTTP.

import { and, eq } from "drizzle-orm";
import { approvals } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { runApprovalSideEffect } from "./side-effects";
import { enqueueTaskDispatch } from "../../../infra/queue/task-worker";

const log = childLogger("services:approvals:decide");

type ApprovalRow = typeof approvals.$inferSelect;

export type DecideApprovalResult =
  | { kind: "ok"; approval: ApprovalRow }
  | { kind: "not_found" }
  | { kind: "already_decided" }
  | { kind: "side_effect_failed"; approval: ApprovalRow; message: string };

export interface DecideApprovalInput {
  approvalId: string;
  companyId: string;
  decidedByUserId: string;
  decision: "approve" | "reject";
  /** Required for reject in practice (callers supply it); ignored on approve. */
  reason?: string | null;
}

export async function decideApproval(
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  // Scope by companyId so a caller can never decide another company's row.
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

  const now = new Date();
  const nextStatus = input.decision === "approve" ? "approved" : "rejected";

  // Step 1 — flip the approval row. Single update, no tx.
  const [updated] = await db
    .update(approvals)
    .set({
      status: nextStatus,
      decidedAt: now,
      decidedByUserId: input.decidedByUserId,
      rejectionReason:
        input.decision === "reject" ? (input.reason ?? null) : null,
      updatedAt: now,
    })
    .where(eq(approvals.id, row.id))
    .returning();

  // Reject path — no side effects (the row flip is the whole story).
  if (input.decision === "reject") {
    return { kind: "ok", approval: updated };
  }

  // Approve path — run the side effect for the action type. Side effects
  // run AFTER the row flip (not in a tx) because some do network calls.
  // On failure we stamp the failure into the payload so the row tells the
  // story, and surface it to the caller.
  let final = updated;
  try {
    final = await runApprovalSideEffect(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    log.error({ err, approvalId: updated.id }, "side-effect failed");
    const payload = (updated.payload ?? {}) as Record<string, unknown>;
    const [stamped] = await db
      .update(approvals)
      .set({
        payload: {
          ...payload,
          failureReason: message,
          failedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, updated.id))
      .returning();
    return { kind: "side_effect_failed", approval: stamped, message };
  }

  // After the side effect commits, kick off async dispatch for any new
  // task we created. enqueueTaskDispatch is fire-and-forget by design.
  const spawnedTaskId =
    typeof (final.payload as Record<string, unknown>)?.spawnedTaskId ===
    "string"
      ? ((final.payload as Record<string, unknown>).spawnedTaskId as string)
      : null;
  if (spawnedTaskId) {
    void enqueueTaskDispatch(spawnedTaskId).catch((err: unknown) =>
      log.error(
        { err, spawnedTaskId },
        "post-decide enqueue task dispatch failed",
      ),
    );
  }

  return { kind: "ok", approval: final };
}
