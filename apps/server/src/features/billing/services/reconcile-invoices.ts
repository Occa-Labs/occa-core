// Invoice reconciliation (Phase 1b-ii).
//
// The live task-complete hook (see invoice-on-task-complete) is best-
// effort — a runtime bug, an un-hooked status path, or a task that
// completed before its agent had a rate set all leave a `done` task
// with no invoice. Reconciliation closes that gap.
//
// Invariant enforced: every `done` task assigned to a rated agent has
// exactly one invoice. This sweep finds violations and back-fills.
//
// Runs in two places:
//   • when an agent's task rate is set     — back-fills its history
//   • when the Invoices view is opened     — self-heal on read
// A scheduled company-wide sweep folds into the Phase 1c treasury bot.

import { and, eq, isNull } from "drizzle-orm";
import { agentRuntimeProfile, invoices, tasks } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { createInvoiceForTask } from "../repositories/invoices";

const log = childLogger("services:reconcile-invoices");

/**
 * Back-fill missing invoices for one agent. Reads the agent's current
 * `task_rate_lamports`; if set (> 0), every `done` task assigned to the
 * agent that lacks an invoice gets one created at that rate.
 *
 * Returns the number of invoices created. No-ops (returns 0) when the
 * agent has no rate — an unrated agent's completed work is not billed.
 *
 * Idempotent: `createInvoiceForTask` is guarded by the `uniq_invoices_task`
 * index, so concurrent reconciles (rate-set + view-open racing) can't
 * double-bill.
 */
export async function reconcileInvoicesForDeployment(
  deploymentId: string,
): Promise<number> {
  const [profile] = await db
    .select({ taskRateLamports: agentRuntimeProfile.taskRateLamports })
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, deploymentId))
    .limit(1);

  const rate = profile?.taskRateLamports ?? null;
  if (rate === null || rate <= 0) return 0;

  // `done` tasks assigned to this agent with no invoice row. LEFT JOIN +
  // IS NULL is the orphan-finding pattern.
  const orphans = await db
    .select({ taskId: tasks.id, companyId: tasks.companyId })
    .from(tasks)
    .leftJoin(invoices, eq(invoices.taskId, tasks.id))
    .where(
      and(
        eq(tasks.assignedDeploymentId, deploymentId),
        eq(tasks.status, "done"),
        isNull(invoices.id),
      ),
    );

  let created = 0;
  for (const orphan of orphans) {
    const invoice = await createInvoiceForTask({
      companyId: orphan.companyId,
      deploymentId,
      taskId: orphan.taskId,
      amountLamports: rate,
    });
    if (invoice) created += 1;
  }

  if (created > 0) {
    log.info(
      { deploymentId, created },
      "reconcile back-filled missing invoices",
    );
  }
  return created;
}
