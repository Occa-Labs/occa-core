"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { request } from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AgentWalletResponse {
  /** Receiving address (Solana base58) — null if user hasn't set it yet,
   *  or if chain holds the unset sentinel `Pubkey::default()`. */
  address: string | null;
  /** Live SOL balance in lamports. Null when address unset. */
  balanceLamports: number | null;
  /** True if address is configured (saves a null-check on `address`). */
  hasAddress: boolean;
}

export interface AgentWalletTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** "error" if the tx errored on chain, null on success. */
  err: "error" | null;
  memo: string | null;
}

export interface AgentWalletTransactionsResponse {
  transactions: AgentWalletTransaction[];
  /** Cursor for the next page (the last signature on this page) — null
   *  when this is the final page. */
  nextCursor: string | null;
}

export interface AgentOnChainDeployment {
  deploymentPda: string;
  deploymentIndex: number;
  agentIdentityPda: string;
  companyPda: string;
  owner: string;
  receivingAddress: string | null;
  adapterId: string;
  role: string;
  parentDeploymentIndex: number | null;
  status: string;
  metadataUri: string;
}

export interface AgentOnChainIdentity {
  identityPda: string;
  agentPubkey: string;
  owner: string;
  name: string;
  metadataUri: string;
}

export interface AgentOnChainResponse {
  /** Null when chain hasn't been read yet (read failure or pre-anchor). */
  deployment: AgentOnChainDeployment | null;
  identity: AgentOnChainIdentity | null;
}

export type InvoiceStatus = "pending" | "approved" | "paid" | "void";

export interface AgentInvoice {
  id: string;
  amountLamports: number;
  /** Payout asset mint this invoice settles in — SOL pseudo-mint or an SPL
   *  mint. Frozen at creation; format the amount by this, not always SOL. */
  mint: string;
  status: InvoiceStatus;
  taskId: string | null;
  /** Originating task's title — null if the task was deleted. */
  taskTitle: string | null;
  taskNumber: number | null;
  /** Disbursement tx signature — null until settled (Phase 1c). */
  txSignature: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface AgentInvoicesResponse {
  invoices: AgentInvoice[];
  pendingCount: number;
}

// ── Query keys ─────────────────────────────────────────────────────────────

export const agentWalletKeys = {
  all: ["agent-wallet"] as const,
  wallet: (agentId: string) =>
    [...agentWalletKeys.all, "wallet", agentId] as const,
  transactions: (agentId: string) =>
    [...agentWalletKeys.all, "transactions", agentId] as const,
  onchain: (agentId: string) =>
    [...agentWalletKeys.all, "onchain", agentId] as const,
  invoices: (agentId: string) =>
    [...agentWalletKeys.all, "invoices", agentId] as const,
};

// ── Hooks ──────────────────────────────────────────────────────────────────

// 30s — balance changes are user-initiated (someone sent SOL to the
// address) so polling tighter than this just burns RPC budget.
const WALLET_REFETCH_MS = 30_000;

export function useAgentWallet(agentId: string, enabled = true) {
  return useQuery({
    queryKey: agentWalletKeys.wallet(agentId),
    queryFn: () =>
      request<AgentWalletResponse>(`/api/agents/${agentId}/wallet`),
    enabled,
    refetchInterval: WALLET_REFETCH_MS,
    refetchOnWindowFocus: false,
  });
}

export function useAgentWalletTransactions(agentId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: agentWalletKeys.transactions(agentId),
    queryFn: ({ pageParam }) => {
      const qs = pageParam ? `?before=${encodeURIComponent(pageParam)}` : "";
      return request<AgentWalletTransactionsResponse>(
        `/api/agents/${agentId}/wallet/transactions${qs}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useAgentOnChain(agentId: string, enabled = true) {
  return useQuery({
    queryKey: agentWalletKeys.onchain(agentId),
    queryFn: () =>
      request<AgentOnChainResponse>(`/api/agents/${agentId}/onchain`),
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useAgentInvoices(agentId: string, enabled = true) {
  return useQuery({
    queryKey: agentWalletKeys.invoices(agentId),
    queryFn: () =>
      request<AgentInvoicesResponse>(`/api/agents/${agentId}/invoices`),
    enabled,
    refetchOnWindowFocus: false,
  });
}
