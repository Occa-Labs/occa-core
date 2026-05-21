// Auto-invoice on task completion (Phase 1b-ii).
//
// Called from the dispatcher when a task settles to `done`. Resolves the
// assigned agent's flat per-task rate and, if one is configured, creates
// a pending invoice billing the company that amount.
//
// Idempotent end-to-end: the guard re-reads task status, and the
// `uniq_invoices_task` index absorbs any double-fire — so callers may
// invoke this without dedup bookkeeping.

import { eq } from "drizzle-orm";
import { agentRuntimeProfile, tasks } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { createInvoiceForTask } from "../repositories/invoices";

const log = childLogger("services:invoice-on-task-complete");

/**
 * Create a pending invoice for a just-completed task. No-ops (returns
 * silently) when:
 *   - the task no longer exists
 *   - the task isn't `done` (e.g. it moved back to review)
 *   - the task has no assigned agent
 *   - the agent has no `task_rate_lamports` set (or it's 0)
 *   - an invoice for the task already exists
 */
export async function ensureInvoiceForCompletedTask(args: {
  taskId: string;
}): Promise<void> {
  const { taskId } = args;

  const [task] = await db
    .select({
      id: tasks.id,
      companyId: tasks.companyId,
      status: tasks.status,
      assignedDeploymentId: tasks.assignedDeploymentId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) return;
  if (task.status !== "done") return;
  if (!task.assignedDeploymentId) return;

  const [profile] = await db
    .select({ taskRateLamports: agentRuntimeProfile.taskRateLamports })
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, task.assignedDeploymentId))
    .limit(1);

  const rate = profile?.taskRateLamports ?? null;
  if (rate === null || rate <= 0) return;

  const invoice = await createInvoiceForTask({
    companyId: task.companyId,
    deploymentId: task.assignedDeploymentId,
    taskId: task.id,
    amountLamports: rate,
  });

  if (invoice) {
    log.info(
      {
        invoiceId: invoice.id,
        taskId: task.id,
        deploymentId: task.assignedDeploymentId,
        amountLamports: rate,
      },
      "invoice created for completed task",
    );
  }
}
