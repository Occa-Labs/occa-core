"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Anchor,
  Check,
  Coins,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Receipt,
  RefreshCw,
  Wallet,
  X,
} from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { useSignTransaction as useSolanaSignTransaction } from "@privy-io/react-auth/solana";
import type { AgentDTO } from "@occa/shared/types";
import { Modal } from "@/components/ui/modal";
import { Card } from "@/components/ui/card";
import { ApiError, agentsApi, chainApi } from "@/lib/api";
import { SOLANA_CAIP_CHAIN } from "@/lib/env-flags";
import { formatRoleLabel } from "@/lib/format-role";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import { AnchorAgentPanel } from "./anchor-panels";
import {
  classifyWalletError,
  mapServerError,
  prettifyAnchorError,
  type AnchorErrorCode,
} from "@/features/chain/lib/anchor-errors";
import {
  agentWalletKeys,
  useAgentInvoices,
  useAgentOnChain,
  useAgentWallet,
  useAgentWalletTransactions,
  type AgentInvoice,
  type AgentWalletTransaction,
  type InvoiceStatus,
} from "../api/use-agent-wallet";

// 1 SOL = 10^9 lamports — fixed Solana primitive, safe to inline as a
// constant rather than pull web3.js LAMPORTS_PER_SOL just for division.
const LAMPORTS_PER_SOL = 1_000_000_000;

// Devnet explorer — matches `SOLANA_CAIP_CHAIN` default. If we ever
// promote to mainnet, swap the cluster query string here.
const SOLSCAN_BASE = "https://solscan.io";
const SOLSCAN_CLUSTER_QS = "?cluster=devnet";

function solscanAddressUrl(addr: string): string {
  return `${SOLSCAN_BASE}/account/${addr}${SOLSCAN_CLUSTER_QS}`;
}

function solscanTxUrl(sig: string): string {
  return `${SOLSCAN_BASE}/tx/${sig}${SOLSCAN_CLUSTER_QS}`;
}

function shortenAddress(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function formatLamports(lamports: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  if (sol === 0) return "0";
  if (sol < 0.0001) return sol.toExponential(2);
  return sol.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

function formatBlockTime(blockTime: number | null): string {
  if (blockTime === null) return "—";
  const date = new Date(blockTime * 1000);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Agent chain detail root ────────────────────────────────────────────────

type DetailTab = "invoices" | "transactions" | "onchain";

const DETAIL_TABS: { id: DetailTab; label: string; icon: React.ReactNode }[] = [
  {
    id: "invoices",
    label: "Invoices",
    icon: <Receipt className="size-3.5" />,
  },
  {
    id: "transactions",
    label: "Transactions",
    icon: <RefreshCw className="size-3.5" />,
  },
  {
    id: "onchain",
    label: "On-chain",
    icon: <ExternalLink className="size-3.5" />,
  },
];

export function WalletTab({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>("invoices");
  const wallet = useAgentWallet(agent.id);
  const onchain = useAgentOnChain(agent.id);
  // Loaded eagerly — the summary's pending-invoices stat needs the count
  // even before the user opens the Invoices tab.
  const invoices = useAgentInvoices(agent.id);

  // Pre-anchor agents have no Deployment PDA on chain yet, so we can't
  // call set_receiving_address. Keep the panel visible (so users see the
  // gating reason) but disable the action.
  const isAnchored = agent.agentChainTxSignature !== null;

  // When the agent's chainTxSignature flips from null → set (anchor just
  // completed), TanStack still holds the pre-anchor cache for wallet /
  // onchain / invoices. Invalidate so the panes re-read fresh chain data
  // instead of stuck showing "not anchored" empty states.
  const prevAnchoredRef = useRef(isAnchored);
  useEffect(() => {
    if (prevAnchoredRef.current === isAnchored) return;
    prevAnchoredRef.current = isAnchored;
    if (!isAnchored) return;
    void queryClient.invalidateQueries({
      queryKey: agentWalletKeys.onchain(agent.id),
    });
    void queryClient.invalidateQueries({
      queryKey: agentWalletKeys.wallet(agent.id),
    });
    void queryClient.invalidateQueries({
      queryKey: agentWalletKeys.invoices(agent.id),
    });
  }, [isAnchored, agent.id, queryClient]);

  // Anchor blocker — surfaces in-place when the selected agent isn't on
  // chain yet. CEO uses the 3-phase flow (company + identity +
  // deployment); non-CEO uses the combined batch flow (1 popup). Both
  // panels auto-unmount once the agent's chainTxSignature populates.
  const needsAnchor =
    agent.provisioningState === "ready" &&
    agent.agentChainTxSignature === null;
  const isCeo = agent.role === CEO_ROLE;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
        <IdentityStrip agent={agent} isAnchored={isAnchored} />

        {needsAnchor && (
          <div className="mt-4 max-w-3xl">
            {isCeo ? (
              <CeoSetupHint />
            ) : (
              <AnchorAgentPanel
                key={agent.id}
                agent={agent}
                onReloadMe={onReloadMe}
              />
            )}
          </div>
        )}

        <div className="mt-4 space-y-4 max-w-3xl">
          <ReceivingWalletCard
            agent={agent}
            wallet={wallet.data}
            loading={wallet.isLoading}
            error={wallet.error}
            canEdit={isAnchored}
            onEdit={() => setEditOpen(true)}
            onRefresh={() => wallet.refetch()}
          />
          <div className="grid grid-cols-2 gap-4">
            <TaskRateCard agent={agent} onReloadMe={onReloadMe} />
            <PendingInvoicesCard
              pendingCount={invoices.data?.pendingCount ?? null}
              loading={invoices.isLoading}
              onView={() => setTab("invoices")}
            />
          </div>
        </div>

        <div className="mt-6 max-w-3xl">
          <TabStrip tabs={DETAIL_TABS} active={tab} onSelect={setTab} />
          <div className="mt-4">
            {tab === "invoices" && (
              <InvoicesView
                invoices={invoices.data?.invoices ?? []}
                loading={invoices.isLoading}
                error={invoices.error}
              />
            )}
            {tab === "transactions" && (
              <TransactionsSection
                agentId={agent.id}
                hasAddress={wallet.data?.hasAddress ?? false}
              />
            )}
            {tab === "onchain" && (
              <OnChainSection
                data={onchain.data}
                loading={onchain.isLoading}
                error={onchain.error}
                isAnchored={isAnchored}
                onRefetch={() => onchain.refetch()}
              />
            )}
          </div>
        </div>
      </div>

      <SetReceivingAddressModal
        open={editOpen}
        agent={agent}
        currentAddress={wallet.data?.address ?? null}
        onClose={() => setEditOpen(false)}
      />
    </div>
  );
}

function IdentityStrip({
  agent,
  isAnchored,
}: {
  agent: AgentDTO;
  isAnchored: boolean;
}) {
  const roleLabel = formatRoleLabel(agent.role);
  // Operators sometimes leave the display name blank → kickoff defaults
  // it to the role label. Avoid rendering "Head of Research / Head of
  // Research" by dropping the subtitle when it would duplicate the name.
  const showSubtitle = agent.name.trim().toLowerCase() !== roleLabel.toLowerCase();
  return (
    <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-white/90 truncate">
          {agent.name}
        </h2>
        {showSubtitle && (
          <p className="text-[11px] text-white/45">{roleLabel}</p>
        )}
      </div>
      <AnchorBadge isAnchored={isAnchored} />
    </div>
  );
}

function AnchorBadge({ isAnchored }: { isAnchored: boolean }) {
  if (isAnchored) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/12 px-2 py-1 text-[11px] font-medium text-emerald-300">
        <Anchor className="size-3" />
        Anchored
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-white/6 px-2 py-1 text-[11px] font-medium text-white/55">
      <span className="size-1.5 rounded-full bg-white/30" />
      Not anchored
    </span>
  );
}

function TabStrip<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: T; label: string; icon: React.ReactNode }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-white/8">
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={`relative inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium transition-colors cursor-pointer ${
              isActive
                ? "text-white/95"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            <span
              className={isActive ? "text-white/80" : "text-white/40"}
            >
              {t.icon}
            </span>
            {t.label}
            {isActive && (
              <span className="absolute inset-x-2 -bottom-px h-px bg-white/85" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── CEO setup hint ────────────────────────────────────────────────────────
//
// Anchoring the CEO is one wizard step (3 phases) that also anchors the
// company itself. The trigger lives in the Registry section since it's
// a company-level setup; here we just signpost it so operators don't get
// stuck looking at a disabled Wallet card.

function CeoSetupHint() {
  return (
    <div className="rounded-xl border border-amber-400/25 bg-amber-500/8 px-4 py-3 flex items-start gap-3">
      <div className="size-7 shrink-0 rounded-full bg-amber-400/20 flex items-center justify-center">
        <Wallet className="size-3.5 text-amber-200" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] font-semibold text-amber-100">
          CEO setup runs from Registry
        </p>
        <p className="mt-0.5 text-[11px] text-amber-100/70 leading-relaxed">
          Anchoring the CEO is part of the company setup wizard. Open the
          <span className="font-medium text-amber-100"> Registry </span>
          section in the sidebar to start or resume.
        </p>
      </div>
    </div>
  );
}

// ── Card label (shared) ────────────────────────────────────────────────────

function CardLabel({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
      <span className="text-white/55">{icon}</span>
      {children}
    </div>
  );
}

// ── Receiving wallet — hero balance card ───────────────────────────────────

function ReceivingWalletCard({
  agent,
  wallet,
  loading,
  error,
  canEdit,
  onEdit,
  onRefresh,
}: {
  agent: AgentDTO;
  wallet:
    | {
        address: string | null;
        balanceLamports: number | null;
        hasAddress: boolean;
      }
    | undefined;
  loading: boolean;
  error: unknown;
  canEdit: boolean;
  onEdit: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!wallet?.address) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  }, [wallet?.address]);

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-4">
        <CardLabel icon={<Wallet className="size-3.5" />}>
          Receiving wallet
        </CardLabel>
        {wallet?.hasAddress && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              title="Refresh balance"
              className="p-1.5 rounded-lg hover:bg-white/8 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
            >
              <RefreshCw className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onEdit}
              disabled={!canEdit}
              title="Change address (funds in old address stay there)"
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-white/55 hover:text-white/90 hover:bg-white/8 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Pencil className="size-3" />
              Change
            </button>
          </div>
        )}
      </div>

      {loading && !wallet ? (
        <div className="flex items-center gap-2 text-xs text-white/40 py-2">
          <Loader2 className="size-3.5 animate-spin" />
          Loading wallet…
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-red-300 py-2">
          <AlertCircle className="size-3.5 shrink-0" />
          Couldn&apos;t load wallet. Solana RPC may be rate-limited.
          <button
            type="button"
            onClick={onRefresh}
            className="underline hover:text-red-200 cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : !wallet?.hasAddress ? (
        <div className="flex flex-col items-start gap-3 py-1">
          <p className="text-xs text-white/55 leading-relaxed max-w-md">
            No receiving address set. Funds disbursed to {agent.name} land
            here. Paste any Solana wallet you control — OCCA never holds the
            private key.
          </p>
          <button
            type="button"
            onClick={onEdit}
            disabled={!canEdit}
            title={
              canEdit
                ? "Set the receiving address on chain"
                : "Anchor this agent on chain first (Agents window → Overview)"
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/16 px-3.5 py-2 text-xs font-medium text-white/90 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <Wallet className="size-3.5" />
            Set wallet address
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold tracking-tight text-white tabular-nums">
              {formatLamports(wallet.balanceLamports ?? 0)}
            </span>
            <span className="text-sm font-medium text-white/40">SOL</span>
          </div>
          <div className="mt-4 flex items-center gap-1.5">
            <code className="text-[11px] font-mono text-white/65 bg-white/5 px-2 py-1 rounded-md select-all">
              {shortenAddress(wallet.address!, 8, 8)}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              title="Copy full address"
              className="p-1.5 rounded-lg hover:bg-white/8 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-400" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
            <a
              href={solscanAddressUrl(wallet.address!)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in Solscan"
              className="p-1.5 rounded-lg hover:bg-white/8 text-white/40 hover:text-white/80 transition-colors"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Pending invoices — stat card ───────────────────────────────────────────

function PendingInvoicesCard({
  pendingCount,
  loading,
  onView,
}: {
  pendingCount: number | null;
  loading: boolean;
  onView: () => void;
}) {
  const hasPending = pendingCount !== null && pendingCount > 0;
  return (
    <Card padding="lg">
      <div className="flex items-center justify-between">
        <CardLabel icon={<Receipt className="size-3.5" />}>
          Pending invoices
        </CardLabel>
        {hasPending && (
          <button
            type="button"
            onClick={onView}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-white/55 hover:text-white/90 hover:bg-white/8 transition-colors cursor-pointer"
          >
            View
          </button>
        )}
      </div>
      <div className="mt-3">
        <span
          className={`text-2xl font-bold tracking-tight tabular-nums ${
            hasPending ? "text-white" : "text-white/30"
          }`}
        >
          {loading && pendingCount === null ? "·" : (pendingCount ?? 0)}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-white/35 leading-relaxed">
        {hasPending
          ? "Awaiting approval + disbursement."
          : "Invoices appear here once this agent completes tasks."}
      </p>
    </Card>
  );
}

// ── Invoices view ──────────────────────────────────────────────────────────

const INVOICE_STATUS_STYLE: Record<
  InvoiceStatus,
  { label: string; cls: string }
> = {
  pending: {
    label: "Pending",
    cls: "text-amber-300 bg-amber-500/12",
  },
  approved: {
    label: "Approved",
    cls: "text-sky-300 bg-sky-500/12",
  },
  paid: {
    label: "Paid",
    cls: "text-emerald-300 bg-emerald-500/12",
  },
  void: {
    label: "Void",
    cls: "text-white/40 bg-white/6",
  },
};

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const s = INVOICE_STATUS_STYLE[status];
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

function InvoicesView({
  invoices,
  loading,
  error,
}: {
  invoices: AgentInvoice[];
  loading: boolean;
  error: unknown;
}) {
  if (loading && invoices.length === 0) {
    return (
      <SectionFrame icon={<Receipt className="size-4" />} title="Invoices">
        <div className="flex items-center gap-2 text-xs text-white/40">
          <Loader2 className="size-3 animate-spin" />
          Loading invoices…
        </div>
      </SectionFrame>
    );
  }

  if (error) {
    return (
      <SectionFrame icon={<Receipt className="size-4" />} title="Invoices">
        <div className="flex items-center gap-2 text-xs text-red-300">
          <AlertCircle className="size-3.5 shrink-0" />
          Couldn&apos;t load invoices.
        </div>
      </SectionFrame>
    );
  }

  if (invoices.length === 0) {
    return (
      <SectionFrame icon={<Receipt className="size-4" />} title="Invoices">
        <div className="text-xs text-white/40 italic">
          No invoices yet. One is created automatically each time this agent
          completes a task — set a task rate first.
        </div>
      </SectionFrame>
    );
  }

  return (
    <SectionFrame icon={<Receipt className="size-4" />} title="Invoices">
      <div className="space-y-1.5">
        {invoices.map((inv) => (
          <div
            key={inv.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/3"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <InvoiceStatusBadge status={inv.status} />
              <span className="text-xs text-white/80 truncate">
                {inv.taskNumber !== null && (
                  <span className="text-white/40 font-mono mr-1.5">
                    #{inv.taskNumber}
                  </span>
                )}
                {inv.taskTitle ?? "(task removed)"}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs font-semibold text-white/90 tabular-nums">
                {formatLamports(inv.amountLamports)}{" "}
                <span className="text-white/40 font-normal">SOL</span>
              </span>
              <span className="text-[11px] text-white/35 tabular-nums w-16 text-right">
                {formatBlockTime(
                  Math.floor(new Date(inv.createdAt).getTime() / 1000),
                )}
              </span>
              {inv.txSignature ? (
                <a
                  href={solscanTxUrl(inv.txSignature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Disbursement transaction"
                  className="p-1 rounded hover:bg-white/8 text-white/30 hover:text-white/70 transition-colors"
                >
                  <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="size-5" />
              )}
            </div>
          </div>
        ))}
      </div>
    </SectionFrame>
  );
}

// ── Task rate — stat card ──────────────────────────────────────────────────
//
// Flat per-task invoice rate. Off-chain operational config — edited via the
// agents PATCH endpoint (no chain tx). When set, completing a task will
// auto-create an invoice for this amount (Phase 1b-ii).

function TaskRateCard({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const rateLamports = agent.taskRateLamports;
  const hasRate = rateLamports !== null && rateLamports > 0;

  const startEdit = useCallback(() => {
    setInput(
      rateLamports !== null ? String(rateLamports / LAMPORTS_PER_SOL) : "",
    );
    setError(null);
    setEditing(true);
  }, [rateLamports]);

  const handleSave = useCallback(async () => {
    const trimmed = input.trim();
    let lamports: number | null;
    if (trimmed === "") {
      lamports = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        setError("Enter a non-negative number, or leave blank to clear.");
        return;
      }
      lamports = Math.round(n * LAMPORTS_PER_SOL);
    }
    setSaving(true);
    setError(null);
    try {
      await agentsApi.patch(agent.id, { taskRateLamports: lamports });
      await onReloadMe();
      // Setting a rate triggers server-side invoice back-fill — invalidate
      // the invoices query so the newly created rows surface without a
      // manual refresh. `onReloadMe` only refreshes the agent list.
      await queryClient.invalidateQueries({
        queryKey: agentWalletKeys.invoices(agent.id),
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? "Save failed." : "Network error.");
    } finally {
      setSaving(false);
    }
  }, [input, agent.id, onReloadMe, queryClient]);

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between">
        <CardLabel icon={<Coins className="size-3.5" />}>Task rate</CardLabel>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-white/55 hover:text-white/90 hover:bg-white/8 transition-colors cursor-pointer"
          >
            <Pencil className="size-3" />
            {hasRate ? "Change" : "Set"}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-2.5">
          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) =>
                setInput(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="0.05"
              inputMode="decimal"
              disabled={saving}
              autoFocus
              className="w-full bg-white/5 ring-1 ring-inset ring-white/12 focus:ring-white/30 rounded-lg pl-2.5 pr-12 py-2 text-xs font-mono text-white/90 placeholder-white/25 outline-none disabled:opacity-50"
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-white/35 font-medium">
              SOL
            </span>
          </div>
          {error && <p className="text-[11px] text-amber-300/80">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/12 hover:bg-white/18 px-3 py-1.5 text-xs font-medium text-white/90 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {saving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white/55 hover:text-white/85 transition-colors disabled:opacity-40 cursor-pointer"
            >
              <X className="size-3" />
              Cancel
            </button>
          </div>
        </div>
      ) : hasRate ? (
        <div className="mt-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tracking-tight text-white tabular-nums">
              {formatLamports(rateLamports!)}
            </span>
            <span className="text-xs font-medium text-white/40">SOL</span>
          </div>
          <p className="mt-1.5 text-[11px] text-white/35">
            Invoiced per completed task.
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <span className="text-2xl font-bold tracking-tight text-white/30 tabular-nums">
            —
          </span>
          <p className="mt-2 text-[11px] text-white/35 leading-relaxed">
            No rate set. {agent.name} won&apos;t be invoiced until you set one.
          </p>
        </div>
      )}
    </Card>
  );
}

// ── Transactions ───────────────────────────────────────────────────────────

function TransactionsSection({
  agentId,
  hasAddress,
}: {
  agentId: string;
  hasAddress: boolean;
}) {
  const txs = useAgentWalletTransactions(agentId, hasAddress);

  const allTxs = useMemo<AgentWalletTransaction[]>(() => {
    if (!txs.data) return [];
    return txs.data.pages.flatMap((p) => p.transactions);
  }, [txs.data]);

  if (!hasAddress) {
    return (
      <SectionFrame
        icon={<RefreshCw className="size-4" />}
        title="Transactions"
      >
        <div className="text-xs text-white/40 italic">
          Set a wallet address to see transactions.
        </div>
      </SectionFrame>
    );
  }

  if (txs.isLoading) {
    return (
      <SectionFrame icon={<RefreshCw className="size-4" />} title="Transactions">
        <div className="flex items-center gap-2 text-xs text-white/40">
          <Loader2 className="size-3 animate-spin" />
          Loading transactions…
        </div>
      </SectionFrame>
    );
  }

  if (allTxs.length === 0) {
    return (
      <SectionFrame icon={<RefreshCw className="size-4" />} title="Transactions">
        <div className="text-xs text-white/40 italic">
          No transactions yet. Once funds land here, signatures will show up.
        </div>
      </SectionFrame>
    );
  }

  return (
    <SectionFrame icon={<RefreshCw className="size-4" />} title="Transactions">
      <div className="space-y-1.5">
        {allTxs.map((tx) => (
          <a
            key={tx.signature}
            href={solscanTxUrl(tx.signature)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-3 px-2 py-1.5 rounded hover:bg-white/5 transition-colors group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <code className="text-[11px] font-mono text-white/70 group-hover:text-white truncate">
                {shortenAddress(tx.signature, 6, 6)}
              </code>
              {tx.err && (
                <span className="text-[10px] font-medium text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                  failed
                </span>
              )}
              {tx.memo && (
                <span className="text-[10px] text-white/35 italic truncate">
                  {tx.memo}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] text-white/40 tabular-nums">
                {formatBlockTime(tx.blockTime)}
              </span>
              <ExternalLink className="size-3 text-white/30 group-hover:text-white/60" />
            </div>
          </a>
        ))}
        {txs.hasNextPage && (
          <button
            type="button"
            onClick={() => txs.fetchNextPage()}
            disabled={txs.isFetchingNextPage}
            className="w-full mt-2 py-1.5 text-[11px] font-medium text-white/55 hover:text-white/85 hover:bg-white/5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {txs.isFetchingNextPage ? "Loading…" : "Load older"}
          </button>
        )}
      </div>
    </SectionFrame>
  );
}

// ── On-chain data ──────────────────────────────────────────────────────────

function OnChainSection({
  data,
  loading,
  error,
  isAnchored,
  onRefetch,
}: {
  data:
    | {
        deployment: {
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
        } | null;
        identity: {
          identityPda: string;
          agentPubkey: string;
          owner: string;
          name: string;
          metadataUri: string;
        } | null;
      }
    | undefined;
  loading: boolean;
  error: unknown;
  /** True iff the agent's `chainTxSignature` is populated. We use this to
   *  distinguish "really not anchored" vs "anchored but chain read came
   *  back empty" (RPC propagation lag, devnet flake, etc.). */
  isAnchored: boolean;
  onRefetch: () => void;
}) {
  if (loading && !data) {
    return (
      <SectionFrame
        icon={<ExternalLink className="size-4" />}
        title="On-chain data"
      >
        <div className="text-xs text-white/40 flex items-center gap-2">
          <Loader2 className="size-3 animate-spin" />
          Reading from chain…
        </div>
      </SectionFrame>
    );
  }

  if (error || (!data?.deployment && !data?.identity)) {
    // Two distinct empty states:
    // - Anchored agent + no chain data = RPC lagging behind the confirmed
    //   tx (or read failed). User can retry.
    // - Not anchored = directs the operator to the inline anchor panel
    //   that lives above this tab when the agent isn't anchored.
    const lagging = isAnchored;
    return (
      <SectionFrame
        icon={<ExternalLink className="size-4" />}
        title="On-chain data"
        action={
          lagging ? (
            <button
              type="button"
              onClick={onRefetch}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-white/55 hover:text-white/90 hover:bg-white/8 transition-colors cursor-pointer"
            >
              <RefreshCw className="size-3" />
              Retry
            </button>
          ) : null
        }
      >
        {lagging ? (
          <div className="text-xs text-white/55 leading-relaxed">
            Agent is anchored on chain, but the read returned no data. RPC
            might be lagging behind the latest confirmed tx — retry in a
            few seconds.
          </div>
        ) : (
          <div className="text-xs text-white/40 italic">
            Agent isn&apos;t anchored yet. Use the &ldquo;Anchor on
            Solana&rdquo; panel above to register the Deployment + Identity
            PDAs.
          </div>
        )}
      </SectionFrame>
    );
  }

  return (
    <SectionFrame
      icon={<ExternalLink className="size-4" />}
      title="On-chain data"
    >
      <div className="space-y-4">
        {data.deployment && (
          <DataGroup label="Deployment PDA">
            <DataRow label="Address" value={data.deployment.deploymentPda} mono link />
            <DataRow label="Index" value={String(data.deployment.deploymentIndex)} />
            <DataRow label="Role" value={data.deployment.role} />
            <DataRow label="Status" value={data.deployment.status} />
            <DataRow
              label="Reports to (index)"
              value={
                data.deployment.parentDeploymentIndex === null
                  ? "—"
                  : String(data.deployment.parentDeploymentIndex)
              }
            />
            <DataRow label="Owner" value={data.deployment.owner} mono link />
            <DataRow label="Company PDA" value={data.deployment.companyPda} mono link />
            <DataRow
              label="Receiving address"
              value={data.deployment.receivingAddress ?? "(unset)"}
              mono={!!data.deployment.receivingAddress}
              link={!!data.deployment.receivingAddress}
            />
          </DataGroup>
        )}
        {data.identity && (
          <DataGroup label="Agent Identity PDA">
            <DataRow label="Address" value={data.identity.identityPda} mono link />
            <DataRow label="Pubkey" value={data.identity.agentPubkey} mono link />
            <DataRow label="Name" value={data.identity.name} />
            <DataRow label="Owner" value={data.identity.owner} mono link />
          </DataGroup>
        )}
      </div>
    </SectionFrame>
  );
}

function DataGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-white/35 mb-2">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DataRow({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: boolean;
}) {
  // Sentinel: we use this to avoid linking out for placeholder values.
  const isPlaceholder = value === "(unset)" || value === "—";
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-center">
      <div className="text-[11px] text-white/40">{label}</div>
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`text-[11px] truncate ${
            mono ? "font-mono text-white/80" : "text-white/75"
          }`}
        >
          {mono && !isPlaceholder ? shortenAddress(value, 8, 8) : value}
        </span>
        {link && !isPlaceholder && (
          <a
            href={solscanAddressUrl(value)}
            target="_blank"
            rel="noopener noreferrer"
            className="p-0.5 rounded hover:bg-white/8 text-white/30 hover:text-white/70 transition-colors"
            title="Open in Solscan"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </div>
  );
}

// ── Section frame (shared) ─────────────────────────────────────────────────

function SectionFrame({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/45">
          <span className="text-white/60">{icon}</span>
          {title}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Set / change address modal ─────────────────────────────────────────────

function toBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1)
    bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

type ModalStage =
  | "input"
  | "preparing"
  | "awaiting-signature"
  | "confirming"
  | "done"
  | "error";

function SetReceivingAddressModal({
  open,
  agent,
  currentAddress,
  onClose,
}: {
  open: boolean;
  agent: AgentDTO;
  currentAddress: string | null;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [stage, setStage] = useState<ModalStage>("input");
  const [errorCode, setErrorCode] = useState<AnchorErrorCode | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const walletStatus = useAnchorWallet();
  const { signTransaction } = useSolanaSignTransaction();
  const queryClient = useQueryClient();

  const validatedPubkey = useMemo<{
    ok: boolean;
    pubkey?: PublicKey;
    reason?: string;
  }>(() => {
    const trimmed = input.trim();
    if (!trimmed) return { ok: false, reason: "Enter a Solana address." };
    try {
      const pk = new PublicKey(trimmed);
      if (pk.equals(PublicKey.default))
        return { ok: false, reason: "Default pubkey is the unset sentinel." };
      if (currentAddress && trimmed === currentAddress)
        return { ok: false, reason: "Same as current address." };
      return { ok: true, pubkey: pk };
    } catch {
      return { ok: false, reason: "Not a valid base58 Solana pubkey." };
    }
  }, [input, currentAddress]);

  const reset = useCallback(() => {
    setInput("");
    setStage("input");
    setErrorCode(null);
    setErrorMsg(null);
  }, []);

  const handleClose = useCallback(() => {
    if (stage === "preparing" || stage === "confirming") return;
    reset();
    onClose();
  }, [stage, reset, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!validatedPubkey.ok || !validatedPubkey.pubkey) return;
    if (walletStatus.kind !== "ready") {
      setErrorCode(
        walletStatus.kind === "loading"
          ? "wallet_not_ready"
          : walletStatus.kind === "no-wallet"
            ? "wallet_not_connected"
            : "wallet_mismatch",
      );
      setErrorMsg(null);
      setStage("error");
      return;
    }

    const newAddress = validatedPubkey.pubkey.toBase58();
    setStage("preparing");
    setErrorCode(null);
    setErrorMsg(null);

    try {
      const prep = await chainApi.prepareSetReceivingAddress(agent.id, {
        receivingAddress: newAddress,
      });

      setStage("awaiting-signature");
      let signedBytes: Uint8Array;
      try {
        const out = await signTransaction({
          transaction: toBytes(prep.transaction),
          wallet: walletStatus.wallet,
          chain: SOLANA_CAIP_CHAIN,
        });
        signedBytes = out.signedTransaction;
      } catch (err) {
        const m = classifyWalletError(err);
        setErrorCode(m.code);
        setErrorMsg(m.message);
        setStage("error");
        return;
      }

      setStage("confirming");
      await chainApi.confirmSetReceivingAddress(agent.id, {
        signedTransaction: toBase64(signedBytes),
        blockhash: prep.blockhash,
        lastValidBlockHeight: prep.lastValidBlockHeight,
        receivingAddress: newAddress,
      });

      // Refresh wallet, on-chain view, and the agents list (DTO mirrors
      // receivingAddress from the same column we just updated).
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: agentWalletKeys.wallet(agent.id),
        }),
        queryClient.invalidateQueries({
          queryKey: agentWalletKeys.transactions(agent.id),
        }),
        queryClient.invalidateQueries({
          queryKey: agentWalletKeys.onchain(agent.id),
        }),
      ]);

      setStage("done");
      // Auto-dismiss after a beat so the user sees the success tick.
      setTimeout(() => {
        reset();
        onClose();
      }, 900);
    } catch (err) {
      const m = mapServerError(err);
      setErrorCode(m.code);
      setErrorMsg(err instanceof ApiError ? null : m.message);
      setStage("error");
    }
  }, [
    validatedPubkey,
    walletStatus,
    agent.id,
    signTransaction,
    queryClient,
    reset,
    onClose,
  ]);

  const busy =
    stage === "preparing" ||
    stage === "awaiting-signature" ||
    stage === "confirming";

  const action = currentAddress ? "Change" : "Set";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`${action} receiving wallet`}
      subtitle={`${agent.name} — ${agent.role}`}
      width="min(480px, 92vw)"
      footer={
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/8">
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium text-white/60 hover:text-white/85 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!validatedPubkey.ok || busy || stage === "done"}
            className="inline-flex items-center gap-1.5 rounded-md bg-white/12 hover:bg-white/18 px-3 py-1.5 text-xs font-medium text-white/90 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy && <Loader2 className="size-3 animate-spin" />}
            {stage === "done" && <Check className="size-3 text-emerald-400" />}
            {stage === "preparing"
              ? "Preparing…"
              : stage === "awaiting-signature"
                ? "Waiting for signature…"
                : stage === "confirming"
                  ? "Confirming on chain…"
                  : stage === "done"
                    ? "Saved"
                    : `${action} address`}
          </button>
        </div>
      }
    >
      <div className="px-5 py-4 space-y-3">
        {currentAddress && (
          <div className="text-[11px] text-white/45">
            Current: <code className="font-mono text-white/65">
              {shortenAddress(currentAddress, 6, 6)}
            </code>
            <span className="block mt-0.5 text-white/35">
              Funds already in the old address stay there. Only future
              disbursements route to the new one.
            </span>
          </div>
        )}
        <div>
          <label className="block text-[11px] font-medium text-white/55 mb-1.5">
            New receiving address (Solana base58)
          </label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. 7xKXt…Y3pQ"
            disabled={busy || stage === "done"}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-white/5 ring-1 ring-inset ring-white/12 focus:ring-white/30 rounded-md px-2.5 py-2 text-xs font-mono text-white/90 placeholder-white/25 outline-none disabled:opacity-50"
          />
          {input.trim() && !validatedPubkey.ok && (
            <p className="mt-1.5 text-[11px] text-amber-300/80">
              {validatedPubkey.reason}
            </p>
          )}
        </div>
        <p className="text-[11px] text-white/40 leading-relaxed">
          OCCA never holds the private key for this address. You&apos;re
          responsible for backing it up. To clear, paste the system wallet
          address (
          <code className="font-mono">11111111111111111111111111111111</code>
          ).
        </p>
        {stage === "error" && errorCode && (
          <ErrorBanner code={errorCode} message={errorMsg} />
        )}
      </div>
    </Modal>
  );
}

function ErrorBanner({
  code,
  message,
}: {
  code: AnchorErrorCode;
  message: string | null;
}) {
  const pretty = prettifyAnchorError(code);
  return (
    <div className="flex items-start gap-2 rounded-md bg-red-500/10 ring-1 ring-inset ring-red-500/20 px-3 py-2">
      <AlertCircle className="size-3.5 text-red-300 mt-0.5 shrink-0" />
      <div className="text-[11px] leading-relaxed">
        <div className="text-red-200 font-medium">{pretty.headline}</div>
        <div className="text-red-300/85 mt-0.5">{pretty.hint}</div>
        {message && (
          <div className="text-red-400/60 font-mono mt-1 text-[10px]">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
