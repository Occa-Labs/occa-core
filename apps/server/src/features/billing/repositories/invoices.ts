// Invoices repository — per-task billing records (Phase 1b).
//
// An invoice is created when an agent completes a task; settlement
// (Phase 1c) flips it pending → approved → paid and stamps the
// disbursement tx signature. Off-chain commerce record — chain only
// sees the eventual aggregate disbursement.

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentIdentities,
  deployments,
  invoices,
  tasks,
} from "@occa/shared/schema";
import { db } from "../../../infra/database/client";
import { PG_ERROR_CODES } from "../../../lib/pg-errors";

export type InvoiceRow = typeof invoices.$inferSelect;

/** Invoice row joined with its originating task's display fields. */
export interface InvoiceWithTask extends InvoiceRow {
  taskTitle: string | null;
  taskNumber: number | null;
}

export interface CreateInvoiceInput {
  companyId: string;
  deploymentId: string;
  taskId: string;
  amountLamports: number;
}

/**
 * Insert an invoice for a completed task. Idempotent: the partial unique
 * index `uniq_invoices_task` guarantees one invoice per task, so a
 * double-fired task-complete hook is absorbed silently. Returns the new
 * row, or `null` when an invoice for that task already existed.
 */
export async function createInvoiceForTask(
  input: CreateInvoiceInput,
): Promise<InvoiceRow | null> {
  try {
    const [row] = await db
      .insert(invoices)
      .values({
        companyId: input.companyId,
        deploymentId: input.deploymentId,
        taskId: input.taskId,
        amountLamports: input.amountLamports,
        status: "pending",
      })
      .returning();
    return row ?? null;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === PG_ERROR_CODES.UNIQUE_VIOLATION
    ) {
      // Invoice for this task already exists — idempotent no-op.
      return null;
    }
    throw err;
  }
}

/**
 * List invoices for a deployment, newest first, each joined with its
 * originating task's title + number. `taskId` is `set null` on task
 * deletion, so the join is a LEFT join — historic invoices survive with
 * `taskTitle: null`.
 */
export async function listInvoicesByDeployment(
  deploymentId: string,
): Promise<InvoiceWithTask[]> {
  const rows = await db
    .select({
      invoice: invoices,
      taskTitle: tasks.title,
      taskNumber: tasks.taskNumber,
    })
    .from(invoices)
    .leftJoin(tasks, eq(invoices.taskId, tasks.id))
    .where(eq(invoices.deploymentId, deploymentId))
    .orderBy(desc(invoices.createdAt));
  return rows.map((r) => ({
    ...r.invoice,
    taskTitle: r.taskTitle ?? null,
    taskNumber: r.taskNumber ?? null,
  }));
}

/** Count pending invoices for a deployment — drives the Wallet tab stat. */
export async function countPendingInvoices(
  deploymentId: string,
): Promise<number> {
  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.deploymentId, deploymentId),
        eq(invoices.status, "pending"),
      ),
    );
  return rows.length;
}

/** A pending invoice joined with the agent's payout routing fields. */
export interface PendingInvoiceWithAgent {
  invoiceId: string;
  amountLamports: number;
  deploymentId: string;
  deploymentPda: string;
  agentName: string;
  /** On-chain receiving address — `operating_wallet` column. NULL = unset. */
  receivingAddress: string | null;
}

/**
 * Every pending invoice for a company, joined with the assigned agent's
 * deployment PDA + receiving address. Drives the disbursement-run batch.
 */
export async function listPendingInvoicesForCompany(
  companyId: string,
): Promise<PendingInvoiceWithAgent[]> {
  const rows = await db
    .select({
      invoiceId: invoices.id,
      amountLamports: invoices.amountLamports,
      deploymentId: invoices.deploymentId,
      deploymentPda: deployments.deploymentPda,
      receivingAddress: deployments.operatingWallet,
      agentName: agentIdentities.name,
    })
    .from(invoices)
    .innerJoin(deployments, eq(invoices.deploymentId, deployments.id))
    .innerJoin(
      agentIdentities,
      eq(deployments.agentIdentityId, agentIdentities.id),
    )
    .where(
      and(eq(invoices.companyId, companyId), eq(invoices.status, "pending")),
    )
    .orderBy(desc(invoices.createdAt));
  return rows.map((r) => ({
    invoiceId: r.invoiceId,
    amountLamports: r.amountLamports,
    deploymentId: r.deploymentId,
    deploymentPda: r.deploymentPda,
    agentName: r.agentName,
    receivingAddress: r.receivingAddress,
  }));
}

/**
 * Settle a set of invoices — flip `pending` → `paid`, stamp the
 * disbursement tx signature + paid timestamp. Only rows still `pending`
 * are touched, so a double-confirm is a safe no-op.
 */
export async function markInvoicesPaid(
  invoiceIds: string[],
  txSignature: string,
): Promise<number> {
  if (invoiceIds.length === 0) return 0;
  const updated = await db
    .update(invoices)
    .set({ status: "paid", txSignature, paidAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        inArray(invoices.id, invoiceIds),
        eq(invoices.status, "pending"),
      ),
    )
    .returning({ id: invoices.id });
  return updated.length;
}
