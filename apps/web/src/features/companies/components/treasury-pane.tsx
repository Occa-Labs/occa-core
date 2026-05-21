"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  Coins,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  Send,
} from "lucide-react";
import { useSignTransaction as useSolanaSignTransaction } from "@privy-io/react-auth/solana";
import type { CompanyDTO } from "@occa/shared/types";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError, chainApi } from "@/lib/api";
import { SOLANA_CAIP_CHAIN } from "@/lib/env-flags";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import {
  classifyWalletError,
  mapServerError,
  prettifyAnchorError,
  type AnchorErrorCode,
} from "@/features/chain/lib/anchor-errors";

// 1 SOL = 10^9 lamports.
const LAMPORTS_PER_SOL = 1_000_000_000;
// `0n` literals need an ES2020 TS target — the web app targets lower, so
// use a named zero-bigint constant instead.
const ZERO = BigInt(0);
const SOLSCAN_BASE = "https://solscan.io";
const SOLSCAN_CLUSTER_QS = "?cluster=devnet";

function solscanAddressUrl(addr: string): string {
  return `${SOLSCAN_BASE}/account/${addr}${SOLSCAN_CLUSTER_QS}`;
}

function shortenAddress(addr: string, head = 6, tail = 6): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function lamportsToSol(lamports: bigint | number): string {
  const n = typeof lamports === "bigint" ? Number(lamports) : lamports;
  const sol = n / LAMPORTS_PER_SOL;
  if (sol === 0) return "0";
  return sol.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

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

const treasuryKeys = {
  state: (companyId: string) => ["treasury", "state", companyId] as const,
  disbursements: (companyId: string) =>
    ["treasury", "disbursements", companyId] as const,
};

// ── Treasury pane ──────────────────────────────────────────────────────────

export function TreasuryPane({ company }: { company: CompanyDTO }) {
  const treasury = useQuery({
    queryKey: treasuryKeys.state(company.id),
    queryFn: () => chainApi.getTreasury(company.id),
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (treasury.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40 p-1">
        <Loader2 className="size-3.5 animate-spin" />
        Reading treasury from chain…
      </div>
    );
  }

  // 412 → company not anchored; any error → can't reach chain state.
  if (treasury.error) {
    const notAnchored =
      treasury.error instanceof ApiError && treasury.error.status === 412;
    return (
      <Alert variant={notAnchored ? "warning" : "error"}>
        {notAnchored ? (
          <p>
            This company isn&apos;t anchored on Solana yet. Anchor it from the
            On-chain section first — the treasury is created with it.
          </p>
        ) : (
          <p>Couldn&apos;t read treasury state from chain. Try again.</p>
        )}
      </Alert>
    );
  }

  const t = treasury.data!;

  if (!t.initialized) {
    return (
      <Alert variant="warning">
        <p>
          Treasury account not initialized on chain. Companies created before
          the treasury-CPI flow don&apos;t have one — re-anchoring is needed.
        </p>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <TreasuryBalanceCard
        treasuryPda={t.treasuryPda}
        balanceLamports={t.balanceLamports}
        onRefresh={() => treasury.refetch()}
      />
      <DiscretionaryBudgetCard
        companyId={company.id}
        budgetLamports={BigInt(t.discretionaryBudgetLamports)}
        spentLamports={BigInt(t.discretionarySpentLamports)}
        feeBps={t.agentOperatingFeeBps}
        onSaved={() => treasury.refetch()}
      />
      <PendingDisbursementsCard
        companyId={company.id}
        onSettled={() => treasury.refetch()}
      />
    </div>
  );
}

// ── Balance + funding ──────────────────────────────────────────────────────

function TreasuryBalanceCard({
  treasuryPda,
  balanceLamports,
  onRefresh,
}: {
  treasuryPda: string;
  balanceLamports: number;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(treasuryPda);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  }, [treasuryPda]);

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
          <Coins className="size-3.5 text-white/55" />
          Company treasury
        </div>
        <button
          type="button"
          onClick={onRefresh}
          title="Refresh balance"
          className="p-1.5 rounded-lg hover:bg-white/8 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-bold tracking-tight text-white tabular-nums">
          {lamportsToSol(balanceLamports)}
        </span>
        <span className="text-sm font-medium text-white/40">SOL</span>
      </div>

      <div className="mt-4 flex items-center gap-1.5">
        <code className="text-[11px] font-mono text-white/65 bg-white/5 px-2 py-1 rounded-md select-all">
          {shortenAddress(treasuryPda, 8, 8)}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy treasury address"
          className="p-1.5 rounded-lg hover:bg-white/8 text-white/40 hover:text-white/80 transition-colors cursor-pointer"
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-400" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
        <a
          href={solscanAddressUrl(treasuryPda)}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Solscan"
          className="p-1.5 rounded-lg hover:bg-white/8 text-white/40 hover:text-white/80 transition-colors"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>

      <p className="mt-3 text-[11px] text-white/40 leading-relaxed">
        To fund the treasury, send devnet SOL to this address from any
        wallet. Disbursements to agents draw from this balance.
      </p>
    </Card>
  );
}

// ── Discretionary budget ───────────────────────────────────────────────────

type SaveStage =
  | "idle"
  | "preparing"
  | "awaiting-signature"
  | "confirming"
  | "done"
  | "error";

function DiscretionaryBudgetCard({
  companyId,
  budgetLamports,
  spentLamports,
  feeBps,
  onSaved,
}: {
  companyId: string;
  budgetLamports: bigint;
  spentLamports: bigint;
  feeBps: number;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [stage, setStage] = useState<SaveStage>("idle");
  const [errorCode, setErrorCode] = useState<AnchorErrorCode | null>(null);

  const walletStatus = useAnchorWallet();
  const { signTransaction } = useSolanaSignTransaction();

  const hasBudget = budgetLamports > ZERO;
  const remaining = budgetLamports - spentLamports;

  const startEdit = useCallback(() => {
    setInput(hasBudget ? String(Number(budgetLamports) / LAMPORTS_PER_SOL) : "");
    setErrorCode(null);
    setStage("idle");
    setEditing(true);
  }, [hasBudget, budgetLamports]);

  const handleSave = useCallback(async () => {
    const trimmed = input.trim();
    const n = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(n) || n < 0) {
      setErrorCode("unknown");
      return;
    }
    if (walletStatus.kind !== "ready") {
      setErrorCode(
        walletStatus.kind === "no-wallet"
          ? "wallet_not_connected"
          : walletStatus.kind === "mismatch"
            ? "wallet_mismatch"
            : "wallet_not_ready",
      );
      setStage("error");
      return;
    }

    const lamports = Math.round(n * LAMPORTS_PER_SOL);
    setStage("preparing");
    setErrorCode(null);
    try {
      const prep = await chainApi.prepareSetPolicy(companyId, {
        discretionaryBudgetLamports: lamports,
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
        setStage("error");
        return;
      }

      setStage("confirming");
      await chainApi.confirmSetPolicy(companyId, {
        signedTransaction: toBase64(signedBytes),
        blockhash: prep.blockhash,
        lastValidBlockHeight: prep.lastValidBlockHeight,
      });

      setStage("done");
      onSaved();
      setTimeout(() => {
        setEditing(false);
        setStage("idle");
      }, 900);
    } catch (err) {
      const m = mapServerError(err);
      setErrorCode(m.code);
      setStage("error");
    }
  }, [input, walletStatus, companyId, signTransaction, onSaved]);

  const busy =
    stage === "preparing" ||
    stage === "awaiting-signature" ||
    stage === "confirming";

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
          <Coins className="size-3.5 text-white/55" />
          Monthly disbursement budget
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-white/55 hover:text-white/90 hover:bg-white/8 transition-colors cursor-pointer"
          >
            <Pencil className="size-3" />
            {hasBudget ? "Change" : "Set budget"}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-2.5">
          <div className="relative max-w-50">
            <input
              type="text"
              value={input}
              onChange={(e) =>
                setInput(e.target.value.replace(/[^0-9.]/g, ""))
              }
              placeholder="1.0"
              inputMode="decimal"
              disabled={busy || stage === "done"}
              autoFocus
              className="w-full bg-white/5 ring-1 ring-inset ring-white/12 focus:ring-white/30 rounded-lg pl-2.5 pr-12 py-2 text-xs font-mono text-white/90 placeholder-white/25 outline-none disabled:opacity-50"
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-white/35 font-medium">
              SOL
            </span>
          </div>
          <p className="text-[11px] text-white/40 leading-relaxed">
            Cap on total disbursements per calendar month. A batch payout
            reverts if it would push spend past this cap.
          </p>
          {stage === "error" && errorCode && (
            <ErrorLine code={errorCode} />
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={busy || stage === "done"}
            >
              {busy && <Loader2 className="size-3 animate-spin" />}
              {stage === "done" && (
                <Check className="size-3 text-emerald-500" />
              )}
              {stage === "preparing"
                ? "Preparing…"
                : stage === "awaiting-signature"
                  ? "Sign in wallet…"
                  : stage === "confirming"
                    ? "Confirming…"
                    : stage === "done"
                      ? "Saved"
                      : "Save budget"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {hasBudget ? (
            <>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold tracking-tight text-white tabular-nums">
                  {lamportsToSol(remaining < ZERO ? ZERO : remaining)}
                </span>
                <span className="text-xs font-medium text-white/40">
                  SOL left of {lamportsToSol(budgetLamports)}
                </span>
              </div>
              <p className="text-[11px] text-white/35">
                {lamportsToSol(spentLamports)} SOL disbursed this month.
              </p>
            </>
          ) : (
            <>
              <span className="text-2xl font-bold tracking-tight text-white/30 tabular-nums">
                —
              </span>
              <p className="text-[11px] text-white/35 leading-relaxed">
                No budget set. Disbursements to agents will revert until you
                set a monthly cap.
              </p>
            </>
          )}
          <div className="text-[11px] text-white/35 pt-1 border-t border-white/6">
            Agent Operating Fee:{" "}
            <span className="text-white/55">
              {(feeBps / 100).toFixed(feeBps % 100 === 0 ? 0 : 2)}%
            </span>{" "}
            — deducted from each agent disbursement.
          </div>
        </div>
      )}
    </Card>
  );
}

function ErrorLine({ code }: { code: AnchorErrorCode }) {
  const pretty = prettifyAnchorError(code);
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <AlertCircle className="size-3.5 text-red-300 mt-0.5 shrink-0" />
      <div>
        <span className="text-red-200 font-medium">{pretty.headline}</span>{" "}
        <span className="text-red-300/75">{pretty.hint}</span>
      </div>
    </div>
  );
}

// ── Pending disbursements ──────────────────────────────────────────────────

function PendingDisbursementsCard({
  companyId,
  onSettled,
}: {
  companyId: string;
  onSettled: () => void;
}) {
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: treasuryKeys.disbursements(companyId),
    queryFn: () => chainApi.getPendingDisbursements(companyId),
    refetchOnWindowFocus: false,
    retry: false,
  });

  const walletStatus = useAnchorWallet();
  const { signTransaction } = useSolanaSignTransaction();
  const [stage, setStage] = useState<SaveStage>("idle");
  const [errorCode, setErrorCode] = useState<AnchorErrorCode | null>(null);
  const [paidCount, setPaidCount] = useState(0);

  const handleRun = useCallback(async () => {
    if (walletStatus.kind !== "ready") {
      setErrorCode(
        walletStatus.kind === "no-wallet"
          ? "wallet_not_connected"
          : walletStatus.kind === "mismatch"
            ? "wallet_mismatch"
            : "wallet_not_ready",
      );
      setStage("error");
      return;
    }

    setStage("preparing");
    setErrorCode(null);
    try {
      const prep = await chainApi.prepareDisbursement(companyId);

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
        setStage("error");
        return;
      }

      setStage("confirming");
      const res = await chainApi.confirmDisbursement(companyId, {
        signedTransaction: toBase64(signedBytes),
        blockhash: prep.blockhash,
        lastValidBlockHeight: prep.lastValidBlockHeight,
        invoiceIds: prep.invoiceIds,
      });

      setPaidCount(res.paidCount);
      setStage("done");
      onSettled();
      void plan.refetch();
      // Agents' invoices flipped to paid — let any open Wallet tab refresh.
      void queryClient.invalidateQueries({ queryKey: ["agent-wallet"] });
      setTimeout(() => setStage("idle"), 2500);
    } catch (err) {
      const m = mapServerError(err);
      setErrorCode(m.code);
      setStage("error");
    }
  }, [walletStatus, companyId, signTransaction, onSettled, plan, queryClient]);

  const busy =
    stage === "preparing" ||
    stage === "awaiting-signature" ||
    stage === "confirming";

  if (plan.isLoading) {
    return (
      <Card padding="lg">
        <DisbursementLabel />
        <div className="mt-3 flex items-center gap-2 text-xs text-white/40">
          <Loader2 className="size-3 animate-spin" />
          Loading pending invoices…
        </div>
      </Card>
    );
  }

  if (plan.error || !plan.data) {
    return (
      <Card padding="lg">
        <DisbursementLabel />
        <p className="mt-3 text-xs text-red-300">
          Couldn&apos;t load pending disbursements.
        </p>
      </Card>
    );
  }

  const d = plan.data;
  const grossNeeded = d.totalLamports + d.estimatedFeeLamports;
  const insufficientBalance = d.treasuryBalanceLamports < grossNeeded;
  const nothingPayable = d.payable.length === 0;

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between">
        <DisbursementLabel />
        {stage === "done" && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300">
            <Check className="size-3" />
            {paidCount} invoice{paidCount === 1 ? "" : "s"} paid
          </span>
        )}
      </div>

      {nothingPayable && d.blocked.length === 0 ? (
        <p className="mt-3 text-xs text-white/40 italic">
          No pending invoices. Completed agent tasks show up here for payout.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {/* Payable agents */}
          {d.payable.map((a) => (
            <div
              key={a.deploymentId}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/3"
            >
              <div className="min-w-0">
                <span className="text-xs text-white/85">{a.agentName}</span>
                <span className="text-[11px] text-white/35 ml-2">
                  {a.invoiceCount} invoice{a.invoiceCount === 1 ? "" : "s"}
                </span>
              </div>
              <span className="text-xs font-semibold text-white/90 tabular-nums shrink-0">
                {lamportsToSol(a.totalLamports)}{" "}
                <span className="text-white/40 font-normal">SOL</span>
              </span>
            </div>
          ))}

          {/* Blocked agents — no receiving address */}
          {d.blocked.map((b) => (
            <div
              key={b.deploymentId}
              className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/8 text-[11px]"
            >
              <AlertCircle className="size-3.5 text-amber-300 mt-0.5 shrink-0" />
              <span className="text-amber-100/80">
                <span className="font-medium">{b.agentName}</span> has{" "}
                {b.invoiceCount} pending invoice
                {b.invoiceCount === 1 ? "" : "s"} but no receiving address —
                set one in the agent&apos;s Wallet tab to include them.
              </span>
            </div>
          ))}

          {/* Totals */}
          {!nothingPayable && (
            <div className="pt-2 border-t border-white/6 space-y-1 text-[11px]">
              <Row label="To agents" value={`${lamportsToSol(d.totalLamports)} SOL`} />
              <Row
                label={`Operating fee (${(d.feeBps / 100).toFixed(d.feeBps % 100 === 0 ? 0 : 2)}%)`}
                value={`${lamportsToSol(d.estimatedFeeLamports)} SOL`}
              />
              <Row
                label="Total from treasury"
                value={`${lamportsToSol(grossNeeded)} SOL`}
                emphasis
              />
            </div>
          )}

          {insufficientBalance && !nothingPayable && (
            <Alert variant="warning">
              <p>
                Treasury balance ({lamportsToSol(d.treasuryBalanceLamports)}{" "}
                SOL) is below the {lamportsToSol(grossNeeded)} SOL needed. Fund
                the treasury before running, or the payout will revert.
              </p>
            </Alert>
          )}

          {stage === "error" && errorCode && <ErrorLine code={errorCode} />}

          {!nothingPayable && (
            <Button
              variant="primary"
              size="sm"
              onClick={handleRun}
              disabled={busy || stage === "done"}
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Send className="size-3" />
              )}
              {stage === "preparing"
                ? "Preparing…"
                : stage === "awaiting-signature"
                  ? "Sign in wallet…"
                  : stage === "confirming"
                    ? "Confirming…"
                    : stage === "done"
                      ? "Done"
                      : "Run disbursement"}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function DisbursementLabel() {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
      <Send className="size-3.5 text-white/55" />
      Pending disbursements
    </div>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={emphasis ? "text-white/70" : "text-white/40"}>
        {label}
      </span>
      <span
        className={`tabular-nums ${
          emphasis ? "text-white/90 font-semibold" : "text-white/65"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
