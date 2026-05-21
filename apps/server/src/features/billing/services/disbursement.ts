// Disbursement plan (Phase 1c-ii).
//
// Pending invoices are settled per AGENT, not per invoice: one
// `disburse_discretionary` ix pays an agent the sum of their pending
// invoices, and all of those invoices flip to `paid` under that one tx.
// Fewer instructions → the batch fits in a single Solana transaction.
//
// An agent with pending invoices but no on-chain receiving address can't
// be paid — those land in `blocked` so the UI can prompt the operator to
// set the address first.

import { listPendingInvoicesForCompany } from "../repositories/invoices";

/** One agent's payable line in a disbursement batch. */
export interface AgentDisbursement {
  deploymentId: string;
  deploymentPda: string;
  agentName: string;
  /** Non-null — `blocked` holds the agents missing this. */
  receivingAddress: string;
  invoiceIds: string[];
  /** Sum of the agent's pending invoice amounts, lamports. */
  totalLamports: number;
}

/** An agent that can't be paid yet — no receiving address set. */
export interface BlockedAgent {
  deploymentId: string;
  agentName: string;
  invoiceCount: number;
  totalLamports: number;
}

export interface DisbursementPlan {
  payable: AgentDisbursement[];
  blocked: BlockedAgent[];
  /** Sum across `payable` — the gross to agents (fee is added on-chain). */
  totalLamports: number;
}

// Unset receiving address sentinel — chain stores all-zero pubkey.
const UNSET_ADDRESS = "11111111111111111111111111111111";

function isUnset(addr: string | null): boolean {
  return !addr || addr === UNSET_ADDRESS;
}

/**
 * Group a company's pending invoices into a per-agent disbursement plan.
 * Pure aggregation over the DB — no chain calls.
 */
export async function buildDisbursementPlan(
  companyId: string,
): Promise<DisbursementPlan> {
  const pending = await listPendingInvoicesForCompany(companyId);

  // Group by deployment.
  const byAgent = new Map<
    string,
    {
      deploymentPda: string;
      agentName: string;
      receivingAddress: string | null;
      invoiceIds: string[];
      totalLamports: number;
    }
  >();
  for (const inv of pending) {
    let g = byAgent.get(inv.deploymentId);
    if (!g) {
      g = {
        deploymentPda: inv.deploymentPda,
        agentName: inv.agentName,
        receivingAddress: inv.receivingAddress,
        invoiceIds: [],
        totalLamports: 0,
      };
      byAgent.set(inv.deploymentId, g);
    }
    g.invoiceIds.push(inv.invoiceId);
    g.totalLamports += inv.amountLamports;
  }

  const payable: AgentDisbursement[] = [];
  const blocked: BlockedAgent[] = [];
  for (const [deploymentId, g] of byAgent) {
    if (isUnset(g.receivingAddress)) {
      blocked.push({
        deploymentId,
        agentName: g.agentName,
        invoiceCount: g.invoiceIds.length,
        totalLamports: g.totalLamports,
      });
      continue;
    }
    payable.push({
      deploymentId,
      deploymentPda: g.deploymentPda,
      agentName: g.agentName,
      receivingAddress: g.receivingAddress as string,
      invoiceIds: g.invoiceIds,
      totalLamports: g.totalLamports,
    });
  }

  const totalLamports = payable.reduce((s, a) => s + a.totalLamports, 0);
  return { payable, blocked, totalLamports };
}
