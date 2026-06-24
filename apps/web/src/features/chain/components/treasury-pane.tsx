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
import {
  formatAssetAmount,
  SOL_PSEUDO_MINT_BASE58 as SOL_PSEUDO_MINT_MARKER,
} from "@occa/shared/payout-assets";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError, chainApi, type PayoutAsset } from "@/lib/api";
import { SOLANA_CAIP_CHAIN } from "@/lib/env-flags";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import {
  classifyWalletError,
  mapServerError,
  prettifyAnchorError,
  type AnchorErrorCode,
} from "@/features/chain/lib/anchor-errors";
import { TreasuryOperationsSection } from "./treasury-operations-section";

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

// Format a base-unit amount in the active payout asset, e.g. "12.5 USDC".
function fmtAsset(baseUnits: bigint | number, asset: PayoutAsset): string {
  const n = typeof baseUnits === "bigint" ? Number(baseUnits) : baseUnits;
  return `${formatAssetAmount(n, asset.decimals)} ${asset.symbol}`;
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
      <PayoutAssetToggle
        companyId={company.id}
        activeMint={t.asset.mint}
        onSwitched={() => treasury.refetch()}
      />
      <TreasuryBalanceCard
        treasuryPda={t.treasuryPda}
        asset={t.asset}
        assetBalance={t.assetBalance}
        balanceLamports={t.balanceLamports}
        onRefresh={() => treasury.refetch()}
      />
      <DiscretionaryBudgetCard
        companyId={company.id}
        policyPda={t.policyPda}
        asset={t.asset}
        routineBudgetLamports={BigInt(t.routineBudgetLamports)}
        routineSpentLamports={BigInt(t.routineSpentLamports)}
        budgetLamports={BigInt(t.discretionaryBudgetLamports)}
        spentLamports={BigInt(t.discretionarySpentLamports)}
        feeBps={t.agentOperatingFeeBps}
        onSaved={() => treasury.refetch()}
      />
      <PendingDisbursementsCard companyId={company.id} />
      <TreasuryOperationsSection companyId={company.id} />
    </div>
  );
}

// ── Payout asset toggle ────────────────────────────────────────────────────

function PayoutAssetToggle({
  companyId,
  activeMint,
  onSwitched,
}: {
  companyId: string;
  activeMint: string;
  onSwitched: () => void;
}) {
  const queryClient = useQueryClient();
  const assets = useQuery({
    queryKey: ["payout-asset", companyId],
    queryFn: () => chainApi.getPayoutAsset(companyId),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const active = assets.data?.activeMint ?? activeMint;
  const isUsdc = active !== SOL_PSEUDO_MINT_MARKER;

  const handleSwitch = useCallback(
    async (mint: string) => {
      if (mint === active || switching) return;
      setSwitching(mint);
      setError(false);
      try {
        await chainApi.setPayoutAsset(companyId, mint);
        await queryClient.invalidateQueries({
          queryKey: ["payout-asset", companyId],
        });
        // Treasury figures + pending plan are now denominated differently.
        await queryClient.invalidateQueries({
          queryKey: treasuryKeys.disbursements(companyId),
        });
        onSwitched();
      } catch {
        setError(true);
      } finally {
        setSwitching(null);
      }
    },
    [active, switching, companyId, queryClient, onSwitched],
  );

  const options = assets.data?.assets ?? [];

  return (
    <Card padding="lg">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
        <Coins className="size-3.5 text-white/55" />
        Payout asset
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {options.map((opt) => {
          const selected = opt.mint === active;
          const busy = switching === opt.mint;
          return (
            <button
              key={opt.mint}
              type="button"
              onClick={() => handleSwitch(opt.mint)}
              disabled={!!switching}
              className={`flex flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 ring-1 ring-inset transition-colors cursor-pointer disabled:opacity-60 ${
                selected
                  ? "bg-white/10 ring-white/30"
                  : "bg-white/3 ring-white/10 hover:bg-white/6"
              }`}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold text-white/90">
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <span
                    className={`size-2 rounded-full ${selected ? "bg-emerald-400" : "bg-white/20"}`}
                  />
                )}
                {opt.symbol}
              </span>
              <span className="text-[10px] text-white/40">
                {opt.key === "SOL" ? "native" : "SPL token"}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] text-white/40 leading-relaxed">
        New invoices are denominated in the selected asset. Invoices already
        accrued keep the asset they were created in and stay payable in it.
      </p>

      {isUsdc && (
        <p className="mt-2 text-[11px] text-amber-100/80 leading-relaxed">
          The operator must hold a little SOL for first-payout ATA rent
          (~0.002 SOL per new agent), on top of tx fees.
        </p>
      )}

      {error && (
        <p className="mt-2 text-[11px] text-red-300">
          Couldn&apos;t switch payout asset. Try again.
        </p>
      )}
    </Card>
  );
}

// ── Balance + funding ──────────────────────────────────────────────────────

function TreasuryBalanceCard({
  treasuryPda,
  asset,
  assetBalance,
  balanceLamports,
  onRefresh,
}: {
  treasuryPda: string;
  asset: PayoutAsset;
  assetBalance: number;
  balanceLamports: number;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isUsdc = asset.key !== "SOL";

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
          {formatAssetAmount(assetBalance, asset.decimals)}
        </span>
        <span className="text-sm font-medium text-white/40">
          {asset.symbol}
        </span>
      </div>

      {isUsdc && (
        <div className="mt-1.5 text-[11px] text-white/40">
          + {lamportsToSol(balanceLamports)} SOL for gas and ATA rent
        </div>
      )}

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
        {isUsdc
          ? `To fund the treasury, send ${asset.symbol} to this address' associated token account, and keep a little SOL here for gas and ATA rent. Disbursements to agents draw from this balance.`
          : "To fund the treasury, send devnet SOL to this address from any wallet. Disbursements to agents draw from this balance."}
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
  policyPda,
  asset,
  routineBudgetLamports,
  routineSpentLamports,
  budgetLamports,
  spentLamports,
  feeBps,
  onSaved,
}: {
  companyId: string;
  policyPda: string;
  asset: PayoutAsset;
  routineBudgetLamports: bigint;
  routineSpentLamports: bigint;
  budgetLamports: bigint;
  spentLamports: bigint;
  feeBps: number;
  onSaved: () => void;
}) {
  // Budgets are read + written in the company's active payout asset. set_policy
  // merges only this asset's caps on-chain, so other assets' budgets survive.
  const [editing, setEditing] = useState(false);
  const [routineInput, setRoutineInput] = useState("");
  const [discretionaryInput, setDiscretionaryInput] = useState("");
  const [stage, setStage] = useState<SaveStage>("idle");
  const [errorCode, setErrorCode] = useState<AnchorErrorCode | null>(null);
  // Last successful set_policy signature — surfaced in the card body so
  // the operator can audit-jump straight to the on-chain tx without
  // leaving the OS.
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);

  const walletStatus = useAnchorWallet();
  const { signTransaction } = useSolanaSignTransaction();

  const hasBudget =
    budgetLamports > ZERO || routineBudgetLamports > ZERO;

  // Base units per whole token for the active asset (1e9 SOL, 1e6 USDC).
  const perUnit = 10 ** asset.decimals;

  const startEdit = useCallback(() => {
    setRoutineInput(
      routineBudgetLamports > ZERO
        ? String(Number(routineBudgetLamports) / perUnit)
        : "",
    );
    setDiscretionaryInput(
      budgetLamports > ZERO ? String(Number(budgetLamports) / perUnit) : "",
    );
    setErrorCode(null);
    setStage("idle");
    setEditing(true);
  }, [routineBudgetLamports, budgetLamports, perUnit]);

  const handleSave = useCallback(async () => {
    const routineN = Number(routineInput.trim());
    const discretionaryN = Number(discretionaryInput.trim());
    if (
      routineInput.trim() === "" ||
      discretionaryInput.trim() === "" ||
      !Number.isFinite(routineN) ||
      !Number.isFinite(discretionaryN) ||
      routineN < 0 ||
      discretionaryN < 0
    ) {
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

    const routineBase = Math.round(routineN * perUnit);
    const discretionaryBase = Math.round(discretionaryN * perUnit);
    setStage("preparing");
    setErrorCode(null);
    try {
      const prep = await chainApi.prepareSetPolicy(companyId, {
        mint: asset.mint,
        routineBudgetLamports: routineBase,
        discretionaryBudgetLamports: discretionaryBase,
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
      const confirmRes = await chainApi.confirmSetPolicy(companyId, {
        signedTransaction: toBase64(signedBytes),
        blockhash: prep.blockhash,
        lastValidBlockHeight: prep.lastValidBlockHeight,
      });
      setLastTxSig(confirmRes.signature);

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
  }, [
    routineInput,
    discretionaryInput,
    walletStatus,
    companyId,
    signTransaction,
    onSaved,
    asset.mint,
    perUnit,
  ]);

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
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <BudgetInput
              label="Auto-payouts cap"
              hint="OCCA operator signs up to this per month"
              unit={asset.symbol}
              value={routineInput}
              onChange={setRoutineInput}
              disabled={busy || stage === "done"}
              autoFocus
            />
            <BudgetInput
              label="Manual payouts cap"
              hint="You sign each payout via wallet popup"
              unit={asset.symbol}
              value={discretionaryInput}
              onChange={setDiscretionaryInput}
              disabled={busy || stage === "done"}
            />
          </div>
          <p className="text-[11px] text-white/40 leading-relaxed">
            Set the same value for both if you want auto + manual to share
            one monthly pool, or split them (e.g. 0.5 auto / 5 manual
            emergency).
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
          {/* Out-of-sync warning — happens when an old set_policy save ran
              before the server bug-fix that writes both budget classes.
              Surfacing this explicitly so operators don't get stuck
              wondering why Run-routine-payout reverts with "no budget
              configured" even though the card shows a value set. */}
          {routineBudgetLamports !== budgetLamports && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-400/25 px-3 py-2.5 text-[11px] text-amber-100 leading-relaxed">
              <strong className="font-semibold">Budgets out of sync.</strong>{" "}
              On-chain auto-payout cap is{" "}
              {fmtAsset(routineBudgetLamports, asset)}, manual cap is{" "}
              {fmtAsset(budgetLamports, asset)}. Click{" "}
              <strong>Change → Save</strong> again to align both. Run
              routine payout will revert until they match.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-white/3 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-white/35 mb-1">
                Auto-payouts
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-semibold tabular-nums text-white/90">
                  {formatAssetAmount(Number(routineBudgetLamports), asset.decimals)}
                </span>
                <span className="text-[11px] text-white/40">{asset.symbol}</span>
              </div>
              <p className="text-[10px] text-white/40 mt-0.5">
                {formatAssetAmount(Number(routineSpentLamports), asset.decimals)}{" "}
                used this month
              </p>
            </div>
            <div className="rounded-lg bg-white/3 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-white/35 mb-1">
                Manual payouts
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-semibold tabular-nums text-white/90">
                  {formatAssetAmount(Number(budgetLamports), asset.decimals)}
                </span>
                <span className="text-[11px] text-white/40">{asset.symbol}</span>
              </div>
              <p className="text-[10px] text-white/40 mt-0.5">
                {formatAssetAmount(Number(spentLamports), asset.decimals)} used
                this month
              </p>
            </div>
          </div>

          <div className="text-[11px] text-white/35 pt-1 border-t border-white/6">
            Agent Operating Fee:{" "}
            <span className="text-white/55">
              {(feeBps / 100).toFixed(feeBps % 100 === 0 ? 0 : 2)}%
            </span>{" "}
            — deducted from each agent disbursement.
          </div>
          <div className="pt-1 flex items-center gap-1.5 text-[11px] text-white/35">
            <span>Stored on-chain in PolicyAccount</span>
            <span className="text-white/20">·</span>
            <a
              href={solscanAddressUrl(policyPda)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-white/55 hover:text-white/85 transition-colors"
              title="Open PolicyAccount + tx history on Solscan"
            >
              view history
              <ExternalLink className="size-2.5" />
            </a>
            {lastTxSig && (
              <>
                <span className="text-white/20">·</span>
                <a
                  href={`${SOLSCAN_BASE}/tx/${lastTxSig}${SOLSCAN_CLUSTER_QS}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-emerald-300/85 hover:text-emerald-200 transition-colors"
                  title="Latest set_policy tx"
                >
                  <Check className="size-2.5" />
                  latest tx
                  <ExternalLink className="size-2.5" />
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function BudgetInput({
  label,
  hint,
  unit,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  label: string;
  hint: string;
  unit: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10.5px] uppercase tracking-wider text-white/40">
        {label}
      </label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.1"
          inputMode="decimal"
          disabled={disabled}
          autoFocus={autoFocus}
          className="w-full bg-white/5 ring-1 ring-inset ring-white/12 focus:ring-white/30 rounded-lg pl-2.5 pr-12 py-2 text-xs font-mono text-white/90 placeholder-white/25 outline-none disabled:opacity-50"
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-white/35 font-medium">
          {unit}
        </span>
      </div>
      <p className="text-[10.5px] text-white/35 leading-snug">{hint}</p>
    </div>
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
}: {
  companyId: string;
}) {
  const plan = useQuery({
    queryKey: treasuryKeys.disbursements(companyId),
    queryFn: () => chainApi.getPendingDisbursements(companyId),
    refetchOnWindowFocus: false,
    retry: false,
  });

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
  // Per-line asset: a line is either SOL or the active SPL asset. The catalog
  // has a single SPL asset (USDC), so a non-SOL line resolves to it even when
  // the company has since switched the active asset back to SOL.
  const lineAsset = (mint: string): PayoutAsset =>
    mint === SOL_PSEUDO_MINT_MARKER
      ? { key: "SOL", symbol: "SOL", decimals: 9, mint }
      : d.asset.key !== "SOL"
        ? d.asset
        : { key: "USDC", symbol: "USDC", decimals: 6, mint };

  const grossNeeded = d.totalLamports + d.estimatedFeeLamports;
  // Coverage is checked in the ACTIVE asset against its spendable balance.
  // For SOL that's balance minus the rent-exempt floor (chain reverts
  // InsufficientFunds 6025 below it); for SPL it's the full ATA balance.
  const insufficientBalance = d.usableAssetBalance < grossNeeded;
  const nothingPayable = d.payable.length === 0;

  return (
    <Card padding="lg">
      <DisbursementLabel />

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
                {formatAssetAmount(a.totalLamports, lineAsset(a.mint).decimals)}{" "}
                <span className="text-white/40 font-normal">
                  {lineAsset(a.mint).symbol}
                </span>
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

          {/* Totals — denominated in the active payout asset. */}
          {!nothingPayable && (
            <div className="pt-2 border-t border-white/6 space-y-1 text-[11px]">
              <Row label="To agents" value={fmtAsset(d.totalLamports, d.asset)} />
              <Row
                label={`Operating fee (${(d.feeBps / 100).toFixed(d.feeBps % 100 === 0 ? 0 : 2)}%)`}
                value={fmtAsset(d.estimatedFeeLamports, d.asset)}
              />
              <Row
                label="Total from treasury"
                value={fmtAsset(grossNeeded, d.asset)}
                emphasis
              />
            </div>
          )}

          {insufficientBalance && !nothingPayable && (
            <Alert variant="warning">
              {d.asset.key === "SOL" ? (
                <p>
                  <strong>Treasury can&apos;t cover this payout.</strong>{" "}
                  Balance is {lamportsToSol(d.treasuryBalanceLamports)} SOL but
                  only {lamportsToSol(d.usableBalanceLamports)} SOL is usable
                  (Solana protects{" "}
                  {lamportsToSol(d.rentExemptMinLamports)} SOL rent-exempt
                  minimum). Need {lamportsToSol(grossNeeded)} SOL. Top up the
                  treasury before running.
                </p>
              ) : (
                <p>
                  <strong>Treasury can&apos;t cover this payout.</strong>{" "}
                  {d.asset.symbol} balance is{" "}
                  {fmtAsset(d.treasuryAssetBalance, d.asset)} but this run needs{" "}
                  {fmtAsset(grossNeeded, d.asset)}. Send more {d.asset.symbol} to
                  the treasury before running.
                </p>
              )}
            </Alert>
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
