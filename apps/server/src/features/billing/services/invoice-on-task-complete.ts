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
import { SOL_PSEUDO_MINT } from "@occa/sdk";
import { agentRuntimeProfile, companies, tasks } from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { childLogger } from "../../../lib/logger";
import { createInvoiceForTask } from "../repositories/invoices";

const log = childLogger("services:invoice-on-task-complete");

const SOL_MINT = SOL_PSEUDO_MINT.toBase58();

/**
 * Create a pending invoice for a just-completed task. No-ops (returns
 * silently) when:
 *   - the task no longer exists
 *   - the task isn't `done` (e.g. it moved back to review)
 *   - the task has no assigned agent
 *   - the agent has no rate set in the company's active payout asset (or
 *     it's 0)
 *   - an invoice for the task already exists
 *
 * The invoice is denominated in the company's `payout_mint` at completion
 * time and snapshots that mint, so a later asset switch leaves it payable
 * in its original asset. The rate is read from `task_rate_lamports` for SOL
 * or `task_rate_usdc` for an SPL mint — independent per-asset values.
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
      payoutMint: companies.payoutMint,
    })
    .from(tasks)
    .innerJoin(companies, eq(tasks.companyId, companies.id))
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!task) return;
  if (task.status !== "done") return;
  if (!task.assignedDeploymentId) return;

  const [profile] = await db
    .select({
      taskRateLamports: agentRuntimeProfile.taskRateLamports,
      taskRateUsdc: agentRuntimeProfile.taskRateUsdc,
    })
    .from(agentRuntimeProfile)
    .where(eq(agentRuntimeProfile.deploymentId, task.assignedDeploymentId))
    .limit(1);

  // Pick the rate matching the company's active payout asset. SOL and USDC
  // rates are independent; an unset rate in the active asset means "skip",
  // identical to the legacy SOL-only behaviour.
  const mint = task.payoutMint;
  const rate =
    mint === SOL_MINT
      ? (profile?.taskRateLamports ?? null)
      : (profile?.taskRateUsdc ?? null);
  if (rate === null || rate <= 0) return;

  const invoice = await createInvoiceForTask({
    companyId: task.companyId,
    deploymentId: task.assignedDeploymentId,
    taskId: task.id,
    amountLamports: rate,
    mint,
  });

  if (invoice) {
    log.info(
      {
        invoiceId: invoice.id,
        taskId: task.id,
        deploymentId: task.assignedDeploymentId,
        amountLamports: rate,
        mint,
      },
      "invoice created for completed task",
    );
  }
}
