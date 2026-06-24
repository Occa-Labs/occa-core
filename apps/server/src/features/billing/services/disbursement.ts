// Disbursement plan (Phase 1c-ii).
//
// Pending invoices are settled per AGENT and per MINT, not per invoice: one
// disburse ix pays an agent the sum of their pending invoices in a single
// asset, and all of those invoices flip to `paid` under that one tx. Fewer
// instructions → the batch fits in a single Solana transaction.
//
// Multi-asset: an agent may hold pending invoices in more than one mint
// (e.g. older SOL invoices plus newer USDC ones after the company switched
// payout asset). Each (agent, mint) pair is its own line — SOL lines route
// to the native disburse ix, SPL lines to the *_spl ix. Grouping by mint
// keeps each line settleable by exactly one builder.
//
// An agent with pending invoices but no on-chain receiving address can't
// be paid — those land in `blocked` so the UI can prompt the operator to
// set the address first.

import { listPendingInvoicesForCompany } from "../repositories/invoices";

/** One agent's payable line in a disbursement batch — single agent, single mint. */
export interface AgentDisbursement {
  deploymentId: string;
  deploymentPda: string;
  agentName: string;
  /** Non-null — `blocked` holds the agents missing this. */
  receivingAddress: string;
  /** Payout asset base58 mint — all-zero pubkey for SOL, else an SPL mint. */
  mint: string;
  invoiceIds: string[];
  /** Sum of the agent's pending invoice amounts in this mint's base units. */
  totalLamports: number;
}

/** An agent that can't be paid yet — no receiving address set. */
export interface BlockedAgent {
  deploymentId: string;
  agentName: string;
  /** Payout asset base58 mint of the blocked invoices. */
  mint: string;
  invoiceCount: number;
  totalLamports: number;
}

export interface DisbursementPlan {
  payable: AgentDisbursement[];
  blocked: BlockedAgent[];
  /**
   * Per-mint gross across `payable` (base units keyed by base58 mint). Fee
   * is added on-chain. Mixed assets can't share one scalar, so totals are
   * kept per mint.
   */
  totalsByMint: Record<string, number>;
}

// Unset receiving address sentinel — chain stores all-zero pubkey.
const UNSET_ADDRESS = "11111111111111111111111111111111";

function isUnset(addr: string | null): boolean {
  return !addr || addr === UNSET_ADDRESS;
}

/**
 * Group a company's pending invoices into a per-agent, per-mint disbursement
 * plan. Pure aggregation over the DB — no chain calls.
 */
export async function buildDisbursementPlan(
  companyId: string,
): Promise<DisbursementPlan> {
  const pending = await listPendingInvoicesForCompany(companyId);

  // Group by (deployment, mint) — same agent paid in two assets is two lines.
  const byAgentMint = new Map<
    string,
    {
      deploymentId: string;
      deploymentPda: string;
      agentName: string;
      receivingAddress: string | null;
      mint: string;
      invoiceIds: string[];
      totalLamports: number;
    }
  >();
  for (const inv of pending) {
    const key = `${inv.deploymentId}|${inv.mint}`;
    let g = byAgentMint.get(key);
    if (!g) {
      g = {
        deploymentId: inv.deploymentId,
        deploymentPda: inv.deploymentPda,
        agentName: inv.agentName,
        receivingAddress: inv.receivingAddress,
        mint: inv.mint,
        invoiceIds: [],
        totalLamports: 0,
      };
      byAgentMint.set(key, g);
    }
    g.invoiceIds.push(inv.invoiceId);
    g.totalLamports += inv.amountLamports;
  }

  const payable: AgentDisbursement[] = [];
  const blocked: BlockedAgent[] = [];
  for (const g of byAgentMint.values()) {
    if (isUnset(g.receivingAddress)) {
      blocked.push({
        deploymentId: g.deploymentId,
        agentName: g.agentName,
        mint: g.mint,
        invoiceCount: g.invoiceIds.length,
        totalLamports: g.totalLamports,
      });
      continue;
    }
    payable.push({
      deploymentId: g.deploymentId,
      deploymentPda: g.deploymentPda,
      agentName: g.agentName,
      receivingAddress: g.receivingAddress as string,
      mint: g.mint,
      invoiceIds: g.invoiceIds,
      totalLamports: g.totalLamports,
    });
  }

  const totalsByMint: Record<string, number> = {};
  for (const a of payable) {
    totalsByMint[a.mint] = (totalsByMint[a.mint] ?? 0) + a.totalLamports;
  }
  return { payable, blocked, totalsByMint };
}
