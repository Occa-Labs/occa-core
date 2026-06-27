"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CircleSlash,
  ExternalLink,
  Key,
  Loader2,
  PlayCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { useSignTransaction as useSolanaSignTransaction } from "@privy-io/react-auth/solana";
import {
  INSTRUCTION_DISCRIMINATOR,
  TREASURY_INSTRUCTION_DISCRIMINATOR,
} from "@occa/sdk";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import { usePayoutAsset } from "@/features/chain/hooks/use-payout-asset";
import {
  classifyWalletError,
  type AnchorErrorCode,
} from "@/features/chain/lib/anchor-errors";
import { SOLANA_CAIP_CHAIN } from "@/lib/env-flags";
import {
  ApiError,
  chainApi,
  type OperationsAccountState,
  type OperationsKindString,
  type PayoutAsset,
  type RoutinePayoutSummary,
} from "@/lib/api";
import {
  formatAssetAmount,
  SOL_PSEUDO_MINT_BASE58,
} from "@occa/shared/payout-assets";

// Default whitelists per kind — the minimum that lets the registered
// signer execute the ix it exists to authorize. Operator can update via
// `update_operations_capability` later.
const DEFAULT_RATE_LIMIT_PER_PERIOD = 30;
// 0 = no expiry. Sensible default; operator can rotate via update later.
const DEFAULT_EXPIRY_UNIX = 0;

const DISBURSEMENT_WHITELIST = [
  TREASURY_INSTRUCTION_DISCRIMINATOR.disburseRoutine.toString("hex"),
  // SPL sibling — routine payout signs disburse_routine_spl for USDC. Without
  // it on the ops account whitelist the chain rejects USDC auto-payouts with
  // DiscriminatorNotWhitelisted (6018).
  TREASURY_INSTRUCTION_DISCRIMINATOR.disburseRoutineSpl.toString("hex"),
];
const ANCHOR_WHITELIST = [
  INSTRUCTION_DISCRIMINATOR.commitDailyAnchor.toString("hex"),
  // Per-deliverable provenance. The Anchor Wallet signs both the daily
  // Merkle rollup and per-task commit_trace anchors.
  INSTRUCTION_DISCRIMINATOR.commitTrace.toString("hex"),
];

function defaultWhitelistFor(kind: 0 | 1): string[] {
  return kind === 0 ? DISBURSEMENT_WHITELIST : ANCHOR_WHITELIST;
}

// Drift-banner detail copy, per account kind. The newer on-chain action that
// triggered the drift differs by wallet: the Disbursement Wallet gained USDC
// (SPL) payouts, the Anchor Wallet gained per-deliverable provenance. The old
// copy named provenance for both, which read wrong on the disbursement card.
function driftDetailCopy(kind: 0 | 1): string {
  return kind === 0
    ? "OCCA added on-chain USDC payouts that this wallet isn't permitted to sign yet. Sync permissions to turn it on — one owner signature, no other changes."
    : "OCCA added a newer on-chain action (per-article provenance) that this wallet isn't permitted to sign yet. Sync permissions to turn it on — one owner signature, no other changes.";
}

function kindString(kind: 0 | 1): OperationsKindString {
  return kind === 0 ? "disbursement" : "anchor";
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

const operationsKeys = {
  state: (companyId: string) => ["treasury", "operations", companyId] as const,
};

function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(6);
}

// Format a base-unit amount in a payout asset, e.g. "12.5 USDC".
function fmtAsset(baseUnits: number, asset: PayoutAsset): string {
  return `${formatAssetAmount(baseUnits, asset.decimals)} ${asset.symbol}`;
}

function shortenAddress(addr: string, head = 6, tail = 6): string {
  return addr.length <= head + tail + 1
    ? addr
    : `${addr.slice(0, head)}…${addr.slice(-tail)}`;
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

function solscanAddressUrl(addr: string): string {
  return `https://solscan.io/account/${addr}?cluster=devnet`;
}

function solscanTxUrl(sig: string): string {
  return `https://solscan.io/tx/${sig}?cluster=devnet`;
}

function kindLabel(kind: 0 | 1): string {
  return kind === 0 ? "Auto-payout to agents" : "Daily audit commits";
}

// Short verb-y label used in setup buttons + modal titles where the
// noun-style `kindLabel` would read awkwardly ("Set up Auto-payout to
// agents").
function kindShortAction(kind: 0 | 1): string {
  return kind === 0 ? "auto-payouts" : "daily commits";
}

// Friendly label for the next rate-limit rollover. `currentPeriodAnchor`
// is unix seconds aligned to start of current UTC calendar month; reset
// happens at start of the next month. `"0"` = ops not initialized yet.
function nextMonthResetLabel(currentPeriodAnchor: string): string {
  const anchor = Number(currentPeriodAnchor);
  if (!Number.isFinite(anchor) || anchor === 0) {
    return "next month";
  }
  const d = new Date(anchor * 1000);
  // UTC arithmetic — current period anchor is month-aligned UTC, next
  // rollover is start of (UTC year, UTC month + 1).
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function kindDescription(kind: 0 | 1): string {
  return kind === 0
    ? "Auto-signs routine agent payouts so you don't approve each one manually. Capped by the monthly budget + rate limit you set here."
    : "Auto-signs the daily Merkle commit posted by the cron, anchoring the agent's task stream on-chain. One commit per agent per day.";
}

// ── Operations status (read-only) ─────────────────────────────────────────

export function OperationsStatusCard({ companyId }: { companyId: string }) {
  const ops = useQuery({
    queryKey: operationsKeys.state(companyId),
    queryFn: () => chainApi.getOperations(companyId),
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
          <Key className="size-3.5 text-white/55" />
          Autonomous signing
        </div>
        <button
          type="button"
          onClick={() => ops.refetch()}
          title="Refresh"
          disabled={ops.isFetching}
          className="p-1.5 rounded-lg hover:bg-white/8 text-white/40 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw
            className={`size-3.5 ${ops.isFetching ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      <AutonomousSigningExplainer />

      {ops.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-white/40">
          <Loader2 className="size-3 animate-spin" />
          Reading operations state from chain…
        </div>
      ) : ops.error || !ops.data ? (
        <p className="text-xs text-red-300">
          Couldn&apos;t read operations state from chain.
        </p>
      ) : (
        <div className="space-y-2.5">
          {ops.data.operations.map((o) => (
            <OperationsRow
              key={o.kind}
              ops={o}
              companyId={companyId}
              onChanged={() => ops.refetch()}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// Three-step visual that walks operators through what autonomous signing
// actually does. Renders inline above the per-kind cards so users see the
// full flow before deciding to enable anything. Designed to defuse the
// "wait, am I giving away keys?" reflex.
function AutonomousSigningExplainer() {
  return (
    <div className="rounded-xl bg-white/3 border border-white/8 px-4 py-3.5 mb-4">
      <p className="text-[11px] text-white/60 leading-relaxed mb-3">
        Let routine work run without popping your wallet. OCCA&apos;s
        operator key signs on your behalf, scoped to exactly the actions
        you enable below.
      </p>

      <div className="space-y-2">
        <ExplainerStep
          n={1}
          title="Agent finishes a task or daily window closes"
          body="An event triggers either a payout or a daily audit commit."
        />
        <ExplainerStep
          n={2}
          title="OCCA operator key signs the ix"
          body="Bounded by your monthly cap + scoped to the specific action. Can't touch governance, can't move funds elsewhere, can't change ownership."
        />
        <ExplainerStep
          n={3}
          title="Funds or proof land on-chain"
          body="Payouts flow to each agent's pre-set receiving address. Audit commits land in the Registry program. You see every tx in this view."
        />
      </div>

      <p className="text-[10.5px] text-white/45 mt-3 pt-3 border-t border-white/6">
        Pause or disable anytime from the row controls. Funds always live
        in the Treasury PDA, never in OCCA&apos;s wallet.
      </p>
    </div>
  );
}

function ExplainerStep({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="size-5 shrink-0 rounded-full bg-white/8 flex items-center justify-center text-[10px] font-semibold text-white/65">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11.5px] font-medium text-white/85 leading-snug">
          {title}
        </p>
        <p className="mt-0.5 text-[10.5px] text-white/45 leading-relaxed">
          {body}
        </p>
      </div>
    </div>
  );
}

function OperationsRow({
  ops,
  companyId,
  onChanged,
}: {
  ops: OperationsAccountState;
  companyId: string;
  onChanged: () => void;
}) {
  const label = kindLabel(ops.kind);
  const description = kindDescription(ops.kind);

  // Detect when this account's on-chain instruction whitelist is missing
  // a capability OCCA has since added (e.g. commit_trace for per-article
  // provenance). The account still works for what it was set up to do, but
  // the newer action is silently blocked until the owner re-syncs.
  const desiredWhitelist = defaultWhitelistFor(ops.kind);
  const whitelistDrift =
    ops.exists &&
    !ops.revoked &&
    (desiredWhitelist.length !== ops.actionWhitelist.length ||
      desiredWhitelist.some((d) => !ops.actionWhitelist.includes(d)));

  return (
    <div className="px-3 py-2.5 rounded-lg bg-white/3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white/85">{label}</span>
          <StatusBadge ops={ops} />
        </div>
        {ops.exists && ops.signer && (
          <a
            href={solscanAddressUrl(ops.signer)}
            target="_blank"
            rel="noopener noreferrer"
            title="Open signer in Solscan"
            className="inline-flex items-center gap-1 text-[11px] font-mono text-white/55 hover:text-white/85 transition-colors"
          >
            {shortenAddress(ops.signer, 6, 6)}
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      <p className="mt-1 text-[11px] text-white/40 leading-relaxed">
        {description}
      </p>

      {ops.exists && !ops.revoked && (
        <div className="mt-2 flex items-center gap-3 text-[11px] text-white/45">
          <span>
            {ops.signaturesThisPeriod} of {ops.rateLimitPerPeriod} used
            this month
            <span className="text-white/30">
              {" · "}
              resets {nextMonthResetLabel(ops.currentPeriodAnchor)}
            </span>
          </span>
          {ops.expiryUnix !== "0" && (
            <span>
              <span className="text-white/30">expires:</span>{" "}
              {new Date(Number(ops.expiryUnix) * 1000).toLocaleDateString()}
            </span>
          )}
        </div>
      )}

      {!ops.exists && (
        <div className="mt-2.5">
          <OperationsSetupButton
            companyId={companyId}
            kind={ops.kind}
            onDone={onChanged}
          />
        </div>
      )}

      {whitelistDrift && (
        <div className="mt-2.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="size-3.5 shrink-0 text-amber-300 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[11.5px] font-medium text-amber-200 leading-snug">
                Action needed — new capability not enabled yet
              </p>
              <p className="mt-0.5 text-[11px] text-amber-100/70 leading-relaxed">
                {driftDetailCopy(ops.kind)}
              </p>
              <div className="mt-2">
                <ManageOperationsButton
                  companyId={companyId}
                  ops={ops}
                  onDone={onChanged}
                  label="Sync permissions"
                  variant="primary"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {ops.exists && !ops.revoked && (
        <div className="mt-2.5 flex items-center gap-2">
          <ManageOperationsButton
            companyId={companyId}
            ops={ops}
            onDone={onChanged}
          />
          <LifecycleButton
            companyId={companyId}
            kind={ops.kind}
            action="revoke"
            onDone={onChanged}
          />
        </div>
      )}

      {ops.exists && ops.revoked && (
        <div className="mt-2.5">
          <LifecycleButton
            companyId={companyId}
            kind={ops.kind}
            action="close"
            onDone={onChanged}
          />
        </div>
      )}
    </div>
  );
}

// ── Setup button (one-time register flow) ─────────────────────────────────

type SetupStage =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "awaiting-signature" }
  | { kind: "confirming" }
  | { kind: "done"; signature: string }
  | { kind: "error"; message: string };

function OperationsSetupButton({
  companyId,
  kind,
  onDone,
}: {
  companyId: string;
  kind: 0 | 1;
  onDone: () => void;
}) {
  const walletStatus = useAnchorWallet();
  const { signTransaction } = useSolanaSignTransaction();
  const [stage, setStage] = useState<SetupStage>({ kind: "idle" });

  const handleSetup = useCallback(async () => {
    if (walletStatus.kind !== "ready") {
      const code: AnchorErrorCode =
        walletStatus.kind === "no-wallet"
          ? "wallet_not_connected"
          : walletStatus.kind === "mismatch"
            ? "wallet_mismatch"
            : "wallet_not_ready";
      setStage({ kind: "error", message: code });
      return;
    }

    setStage({ kind: "preparing" });
    try {
      // Operator pubkey IS the signer for Phase 1 (same key plays both
      // fee-payer and OperationsAccount.signer roles).
      const { pubkey: operatorPubkey } = await chainApi.getOperatorPubkey();
      const prep = await chainApi.prepareRegisterOperations(companyId, {
        kind: kindString(kind),
        signer: operatorPubkey,
        actionWhitelist: defaultWhitelistFor(kind),
        rateLimitPerPeriod: DEFAULT_RATE_LIMIT_PER_PERIOD,
        expiryUnix: DEFAULT_EXPIRY_UNIX,
      });

      setStage({ kind: "awaiting-signature" });
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
        setStage({ kind: "error", message: m.code });
        return;
      }

      setStage({ kind: "confirming" });
      const res = await chainApi.confirmRegisterOperations(companyId, {
        kind: kindString(kind),
        signedTransaction: toBase64(signedBytes),
        blockhash: prep.blockhash,
        lastValidBlockHeight: prep.lastValidBlockHeight,
      });

      setStage({ kind: "done", signature: res.signature });
      onDone();
    } catch (err) {
      let message = "Setup failed.";
      if (err instanceof ApiError) {
        const body = err.body as { detail?: string; error?: string } | null;
        message = body?.detail ?? body?.error ?? err.message ?? message;
      } else if (err instanceof Error) {
        message = err.message;
      }
      setStage({ kind: "error", message });
    }
  }, [walletStatus, companyId, kind, signTransaction, onDone]);

  const busy =
    stage.kind === "preparing" ||
    stage.kind === "awaiting-signature" ||
    stage.kind === "confirming";

  if (stage.kind === "done") {
    return (
      <a
        href={solscanTxUrl(stage.signature)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300 hover:text-emerald-200"
      >
        <Check className="size-3" />
        Set up — view tx
        <ExternalLink className="size-3" />
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" onClick={handleSetup} disabled={busy}>
        {busy ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            {stage.kind === "preparing"
              ? "Preparing…"
              : stage.kind === "awaiting-signature"
                ? "Sign in wallet…"
                : "Confirming…"}
          </span>
        ) : (
          `Enable ${kindShortAction(kind)}`
        )}
      </Button>
      {stage.kind === "error" && (
        <span className="inline-flex items-center gap-1 text-[11px] text-red-300">
          <AlertTriangle className="size-3" />
          {stage.message}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ ops }: { ops: OperationsAccountState }) {
  if (!ops.exists) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/35">
        <CircleSlash className="size-2.5" />
        off
      </span>
    );
  }
  if (ops.revoked) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-amber-300/90">
        <AlertTriangle className="size-2.5" />
        paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-300/90">
      <ShieldCheck className="size-2.5" />
      on
    </span>
  );
}

// ── Manage button + modal (update capability) ───────────────────────────

function ManageOperationsButton({
  companyId,
  ops,
  onDone,
  label = "Adjust",
  variant = "secondary",
}: {
  companyId: string;
  ops: OperationsAccountState;
  onDone: () => void;
  label?: string;
  variant?: "secondary" | "primary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ManageOperationsModal
        open={open}
        onClose={() => setOpen(false)}
        companyId={companyId}
        ops={ops}
        onDone={() => {
          onDone();
          setOpen(false);
        }}
      />
    </>
  );
}

function ManageOperationsModal({
  open,
  onClose,
  companyId,
  ops,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  ops: OperationsAccountState;
  onDone: () => void;
}) {
  const walletStatus = useAnchorWallet();
  const { signTransaction } = useSolanaSignTransaction();
  const [stage, setStage] = useState<SetupStage>({ kind: "idle" });

  // Local edits — seeded from current on-chain values each time the
  // modal opens.
  const [rateLimit, setRateLimit] = useState(ops.rateLimitPerPeriod);
  // Render as YYYY-MM-DD; convert to unix seconds on submit. 0 = no expiry.
  const [expiryDate, setExpiryDate] = useState(() =>
    ops.expiryUnix === "0"
      ? ""
      : new Date(Number(ops.expiryUnix) * 1000).toISOString().slice(0, 10),
  );

  const handleSubmit = useCallback(async () => {
    if (walletStatus.kind !== "ready") {
      const code: AnchorErrorCode =
        walletStatus.kind === "no-wallet"
          ? "wallet_not_connected"
          : walletStatus.kind === "mismatch"
            ? "wallet_mismatch"
            : "wallet_not_ready";
      setStage({ kind: "error", message: code });
      return;
    }

    // Build diff payload — only include fields the operator actually
    // changed so the on-chain ix encodes the right Option<T> for each.
    const body: {
      kind: OperationsKindString;
      rateLimitPerPeriod?: number;
      expiryUnix?: number;
      actionWhitelist?: string[];
    } = { kind: kindString(ops.kind) };
    if (rateLimit !== ops.rateLimitPerPeriod) {
      body.rateLimitPerPeriod = rateLimit;
    }
    const newExpiryUnix = expiryDate
      ? Math.floor(new Date(expiryDate).getTime() / 1000)
      : 0;
    if (String(newExpiryUnix) !== ops.expiryUnix) {
      body.expiryUnix = newExpiryUnix;
    }
    // Heal whitelist drift: if OCCA has added anchor-class instructions
    // since this account was registered (e.g. commit_trace alongside
    // commit_daily_anchor), re-apply the current default so the signer can
    // execute them. Only sent when the on-chain set differs.
    const desiredWhitelist = defaultWhitelistFor(ops.kind);
    const whitelistDrift =
      desiredWhitelist.length !== ops.actionWhitelist.length ||
      desiredWhitelist.some((d) => !ops.actionWhitelist.includes(d));
    if (whitelistDrift) {
      body.actionWhitelist = desiredWhitelist;
    }
    if (
      body.rateLimitPerPeriod === undefined &&
      body.expiryUnix === undefined &&
      body.actionWhitelist === undefined
    ) {
      setStage({ kind: "error", message: "Nothing changed" });
      return;
    }

    setStage({ kind: "preparing" });
    try {
      const prep = await chainApi.prepareUpdateOperations(companyId, body);

      setStage({ kind: "awaiting-signature" });
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
        setStage({ kind: "error", message: m.code });
        return;
      }

      setStage({ kind: "confirming" });
      const res = await chainApi.confirmUpdateOperations(companyId, {
        kind: kindString(ops.kind),
        signedTransaction: toBase64(signedBytes),
        blockhash: prep.blockhash,
        lastValidBlockHeight: prep.lastValidBlockHeight,
      });

      setStage({ kind: "done", signature: res.signature });
      onDone();
    } catch (err) {
      let message = "Update failed.";
      if (err instanceof ApiError) {
        const body = err.body as { detail?: string; error?: string } | null;
        message = body?.detail ?? body?.error ?? err.message ?? message;
      } else if (err instanceof Error) {
        message = err.message;
      }
      setStage({ kind: "error", message });
    }
  }, [
    walletStatus,
    companyId,
    ops,
    rateLimit,
    expiryDate,
    signTransaction,
    onDone,
  ]);

  const busy =
    stage.kind === "preparing" ||
    stage.kind === "awaiting-signature" ||
    stage.kind === "confirming";

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Adjust ${kindShortAction(ops.kind)}`}
      subtitle="Update limits. Saving re-syncs on-chain permissions."
      footer={
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          {stage.kind === "error" ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-red-300">
              <AlertTriangle className="size-3" />
              {stage.message}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleSubmit}
              disabled={busy}
            >
              {busy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  {stage.kind === "preparing"
                    ? "Preparing…"
                    : stage.kind === "awaiting-signature"
                      ? "Sign…"
                      : "Confirming…"}
                </span>
              ) : (
                "Save changes"
              )}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 px-4 py-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wider text-white/40 mb-1.5">
            Max sign-offs per month
          </label>
          <input
            type="number"
            min={0}
            value={rateLimit}
            onChange={(e) => setRateLimit(parseInt(e.target.value || "0", 10))}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white/90 focus:outline-none focus:border-white/25"
          />
          <p className="mt-1 text-[11px] text-white/40">
            Used this month: {ops.signaturesThisPeriod} of{" "}
            {ops.rateLimitPerPeriod}. Counter resets on the 1st of each
            UTC month.
          </p>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-white/40 mb-1.5">
            Expiry (UTC date)
          </label>
          <input
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            disabled={busy}
            className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white/90 focus:outline-none focus:border-white/25"
          />
          <p className="mt-1 text-[11px] text-white/40">
            Leave blank for no expiry.{" "}
            {ops.expiryUnix === "0" ? "Currently: never expires." : ""}
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ── Lifecycle button (revoke / close, owner-signed) ─────────────────────

type LifecycleAction = "revoke" | "close";

function LifecycleButton({
  companyId,
  kind,
  action,
  onDone,
}: {
  companyId: string;
  kind: 0 | 1;
  action: LifecycleAction;
  onDone: () => void;
}) {
  const walletStatus = useAnchorWallet();
  const { signTransaction } = useSolanaSignTransaction();
  const [stage, setStage] = useState<SetupStage>({ kind: "idle" });

  const label = action === "revoke" ? "Pause" : "Disable & reclaim rent";
  const confirmCopy =
    action === "revoke"
      ? `Pause ${kindShortAction(kind)}? OCCA's operator key will stop signing for this action. You can re-enable later by disabling first and setting up fresh.`
      : `Disable ${kindShortAction(kind)}? On-chain account closed and rent (~0.002 SOL) refunds to your wallet. You can re-enable from scratch later.`;

  const handle = useCallback(async () => {
    if (walletStatus.kind !== "ready") {
      const code: AnchorErrorCode =
        walletStatus.kind === "no-wallet"
          ? "wallet_not_connected"
          : walletStatus.kind === "mismatch"
            ? "wallet_mismatch"
            : "wallet_not_ready";
      setStage({ kind: "error", message: code });
      return;
    }

    // Native confirm is OK for Phase 1 — destructive enough to warrant
    // a deliberate click, not so heavy that we need a custom modal.
    if (typeof window !== "undefined" && !window.confirm(confirmCopy)) return;

    setStage({ kind: "preparing" });
    try {
      const body = { kind: kindString(kind) };
      const prep =
        action === "revoke"
          ? await chainApi.prepareRevokeOperations(companyId, body)
          : await chainApi.prepareCloseOperations(companyId, body);

      setStage({ kind: "awaiting-signature" });
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
        setStage({ kind: "error", message: m.code });
        return;
      }

      setStage({ kind: "confirming" });
      const confirmBody = {
        kind: kindString(kind),
        signedTransaction: toBase64(signedBytes),
        blockhash: prep.blockhash,
        lastValidBlockHeight: prep.lastValidBlockHeight,
      };
      const res =
        action === "revoke"
          ? await chainApi.confirmRevokeOperations(companyId, confirmBody)
          : await chainApi.confirmCloseOperations(companyId, confirmBody);

      setStage({ kind: "done", signature: res.signature });
      onDone();
    } catch (err) {
      let message = `${action} failed.`;
      if (err instanceof ApiError) {
        const body = err.body as { detail?: string; error?: string } | null;
        message = body?.detail ?? body?.error ?? err.message ?? message;
      } else if (err instanceof Error) {
        message = err.message;
      }
      setStage({ kind: "error", message });
    }
  }, [
    walletStatus,
    companyId,
    kind,
    action,
    signTransaction,
    onDone,
    confirmCopy,
  ]);

  const busy =
    stage.kind === "preparing" ||
    stage.kind === "awaiting-signature" ||
    stage.kind === "confirming";

  if (stage.kind === "done") {
    return (
      <a
        href={solscanTxUrl(stage.signature)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300 hover:text-emerald-200"
      >
        <Check className="size-3" />
        {action === "revoke" ? "Paused" : "Disabled"} — view tx
        <ExternalLink className="size-3" />
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant={action === "revoke" ? "danger" : "secondary"}
        onClick={handle}
        disabled={busy}
      >
        {busy ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            {stage.kind === "preparing"
              ? "Preparing…"
              : stage.kind === "awaiting-signature"
                ? "Sign in wallet…"
                : "Confirming…"}
          </span>
        ) : (
          label
        )}
      </Button>
      {stage.kind === "error" && (
        <span className="inline-flex items-center gap-1 text-[11px] text-red-300">
          <AlertTriangle className="size-3" />
          {stage.message}
        </span>
      )}
    </div>
  );
}

// ── Routine payout button ─────────────────────────────────────────────────

type PayoutStage =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; summary: RoutinePayoutSummary }
  | { kind: "error"; message: string };

export function RoutinePayoutButton({
  companyId,
  onSettled,
}: {
  companyId: string;
  onSettled?: () => void;
}) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<PayoutStage>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: () => chainApi.runRoutinePayouts(companyId),
  });

  const handleRun = useCallback(async () => {
    setStage({ kind: "running" });
    try {
      const summary = await mutation.mutateAsync();
      setStage({ kind: "done", summary });
      void queryClient.invalidateQueries({
        queryKey: ["treasury", "disbursements", companyId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["treasury", "state", companyId],
      });
      void queryClient.invalidateQueries({ queryKey: ["agent-wallet"] });
      onSettled?.();
    } catch (err) {
      let message = "Routine payout failed.";
      if (err instanceof ApiError) {
        const body = err.body as { detail?: string; error?: string } | null;
        message = body?.detail ?? body?.error ?? err.message ?? message;
      } else if (err instanceof Error) {
        message = err.message;
      }
      setStage({ kind: "error", message });
    }
  }, [companyId, mutation, onSettled, queryClient]);

  const busy = stage.kind === "running";

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
          <PlayCircle className="size-3.5 text-white/55" />
          Routine payout
        </div>
      </div>

      <p className="text-[11px] text-white/40 leading-relaxed">
        Pay all pending agent invoices in one batch — no wallet popup. The
        Disbursement Wallet bound to this company signs server-side.
        Requires Disbursement operations to be set up above.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          onClick={() => setConfirmOpen(true)}
          disabled={busy}
        >
          {busy ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              Running…
            </span>
          ) : (
            "Run routine payout"
          )}
        </Button>
        <RoutinePayoutConfirmModal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          companyId={companyId}
          onConfirm={async () => {
            setConfirmOpen(false);
            await handleRun();
          }}
          busy={busy}
        />

        {stage.kind === "done" && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300">
            <Check className="size-3" />
            {stage.summary.paidInvoiceCount} invoice
            {stage.summary.paidInvoiceCount === 1 ? "" : "s"} paid
          </span>
        )}
        {stage.kind === "error" && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-300">
            <AlertTriangle className="size-3" />
            {stage.message}
          </span>
        )}
      </div>

      {stage.kind === "done" && stage.summary.failureCount > 0 && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-amber-500/10 text-[11px] text-amber-200/90">
          {stage.summary.failureCount} payout
          {stage.summary.failureCount === 1 ? "" : "s"} failed mid-flight.
          See server logs for details.
        </div>
      )}

      {stage.kind === "done" && stage.summary.results.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {stage.summary.results.map((r) => {
            // Three distinct outcomes per agent:
            //   1. error == null && signature != null → success
            //   2. error != null && signature != null → tx landed but
            //      reverted on-chain (rate limit, budget, whitelist…).
            //      Surface the signature so users can verify on Solscan
            //      AND the chain error so they know why.
            //   3. error != null && signature == null → tx never landed
            //      (network, blockhash expired, etc.). No link to show.
            const reverted = r.error !== null && r.signature !== null;
            return (
              <div
                key={r.deploymentId}
                className="flex items-start justify-between gap-3 text-[11px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-white/85">{r.agentName}</div>
                  {r.error && (
                    <div className="text-red-300/80 truncate mt-0.5">
                      {r.error}
                    </div>
                  )}
                </div>
                {r.signature ? (
                  <a
                    href={solscanTxUrl(r.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1 font-mono shrink-0 transition-colors ${
                      reverted
                        ? "text-red-300/85 hover:text-red-200"
                        : "text-emerald-300/85 hover:text-emerald-200"
                    }`}
                    title={
                      reverted
                        ? "Tx landed but reverted on-chain — view on Solscan"
                        : "Confirmed on-chain"
                    }
                  >
                    {shortenAddress(r.signature, 6, 6)}
                    <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <span className="text-red-300/80 shrink-0">no tx</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ── Routine payout confirm modal ──────────────────────────────────────────
//
// Destructive (real SOL movement, irreversible once tx confirms) — gate
// behind an explicit confirm with full preview of who's being paid and
// how much. Re-fetches the pending plan on open so the preview matches
// what will actually be paid (vs the parent's possibly-stale cache).

function RoutinePayoutConfirmModal({
  open,
  onClose,
  companyId,
  onConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  onConfirm: () => Promise<void> | void;
  busy: boolean;
}) {
  const plan = useQuery({
    queryKey: ["treasury", "disbursements", companyId],
    queryFn: () => chainApi.getPendingDisbursements(companyId),
    enabled: open,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const d = plan.data;
  const grossNeeded = d
    ? d.totalLamports + d.estimatedFeeLamports
    : 0;
  // Coverage is checked in the active asset against its spendable balance —
  // for SOL that's balance minus the rent-exempt floor (chain reverts
  // InsufficientFunds 6025 below it), for SPL the full ATA balance.
  const insufficient = d ? d.usableAssetBalance < grossNeeded : false;
  const nothingPayable = d ? d.payable.length === 0 : false;
  const isSolActive = d?.asset.key === "SOL";
  const canConfirm =
    !!d && !plan.isLoading && !nothingPayable && !insufficient && !busy;

  // Full asset catalog (with mints) so amounts in ANY mint format correctly —
  // a run can pay both the active asset and older invoices in another mint.
  const payoutAsset = usePayoutAsset(companyId);
  const assetByMint = useMemo(() => {
    const m = new Map<string, PayoutAsset>();
    for (const a of payoutAsset.data?.assets ?? []) m.set(a.mint, a);
    return m;
  }, [payoutAsset.data?.assets]);
  const fmtMint = (amount: number, mint: string): string => {
    const a = assetByMint.get(mint);
    if (a) return fmtAsset(amount, a);
    // Before the catalog loads: SOL is fixed, SPL defaults to USDC decimals.
    if (mint === SOL_PSEUDO_MINT_BASE58)
      return `${formatAssetAmount(amount, 9)} SOL`;
    return formatAssetAmount(amount, 6);
  };
  // Legs paid this run in a mint OTHER than the active asset — surfaced so the
  // SOL (or USDC) side of a mixed run isn't hidden from the totals.
  const otherLegs = d
    ? Object.entries(d.totalsByMint)
        .filter(([mint, amount]) => mint !== d.payoutMint && amount > 0)
        .map(([mint, amount]) => ({ mint, amount }))
    : [];

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Confirm routine payout"
      subtitle="Pay all pending agent invoices in one batch"
      width="min(540px, 92vw)"
      footer={
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/8">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            <X className="size-3" />
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Send className="size-3" />
            )}
            {busy
              ? "Running…"
              : nothingPayable
                ? "Nothing to pay"
                : insufficient
                  ? "Insufficient balance"
                  : `Confirm — pay ${d?.payable.length ?? 0} agent${
                      (d?.payable.length ?? 0) === 1 ? "" : "s"
                    }`}
          </Button>
        </div>
      }
    >
      <div className="px-5 py-4 flex flex-col gap-3">
        {plan.isLoading && (
          <div className="flex items-center gap-2 text-[12px] text-white/50">
            <Loader2 className="size-3.5 animate-spin" />
            Loading pending invoices…
          </div>
        )}

        {plan.error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/25 px-3 py-2 text-[11px] text-red-200">
            Couldn&apos;t load pending invoices. Try closing + reopening.
          </div>
        )}

        {d && nothingPayable && d.blocked.length === 0 && (
          <p className="text-[12px] text-white/55 leading-relaxed">
            No pending invoices to pay right now. Completed agent tasks
            show up here once they&apos;re invoiced.
          </p>
        )}

        {d && (d.payable.length > 0 || d.blocked.length > 0) && (
          <>
            {d.payable.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
                  Will be paid
                </p>
                {d.payable.map((a) => (
                  <div
                    key={`${a.deploymentId}-${a.mint}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/3 text-[12px]"
                  >
                    <span className="text-white/85">
                      {a.agentName}
                      <span className="text-white/40 ml-2">
                        ({a.invoiceCount} invoice
                        {a.invoiceCount === 1 ? "" : "s"})
                      </span>
                    </span>
                    <span className="font-semibold text-white/90 tabular-nums">
                      {fmtMint(a.totalLamports, a.mint)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {d.blocked.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10.5px] font-semibold uppercase tracking-wider text-amber-300/70">
                  Skipped — no receiving wallet
                </p>
                {d.blocked.map((b) => (
                  <div
                    key={`${b.deploymentId}-${b.mint}`}
                    className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/8 text-[11px] text-amber-100/85"
                  >
                    <AlertCircle className="size-3.5 text-amber-300 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-medium">{b.agentName}</span>
                      {` has ${b.invoiceCount} pending ${
                        b.mint === SOL_PSEUDO_MINT_BASE58 ? "SOL" : "USDC"
                      } invoice${b.invoiceCount === 1 ? "" : "s"}. Set a receiving address in the agent's Wallet tab to include them next time.`}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {d.payable.length > 0 && (
              <div className="rounded-lg bg-white/3 px-3 py-2.5 mt-1 text-[11px] space-y-1">
                <Row
                  label="To agents (net)"
                  value={fmtAsset(d.totalLamports, d.asset)}
                />
                <Row
                  label={`Operating fee (${(d.feeBps / 100).toFixed(
                    d.feeBps % 100 === 0 ? 0 : 2,
                  )}%)`}
                  value={fmtAsset(d.estimatedFeeLamports, d.asset)}
                />
                <Row
                  label="Total from treasury"
                  value={fmtAsset(grossNeeded, d.asset)}
                  emphasis
                />
                <div className="pt-1.5 mt-1 border-t border-white/6 space-y-1 text-white/40">
                  <div className="flex items-center justify-between">
                    <span>Treasury {d.asset.symbol} after</span>
                    <span className="tabular-nums">
                      {fmtAsset(
                        Math.max(0, d.treasuryAssetBalance - grossNeeded),
                        d.asset,
                      )}
                    </span>
                  </div>
                  {isSolActive && (
                    <div className="flex items-center justify-between text-white/30">
                      <span>Rent-exempt floor</span>
                      <span className="tabular-nums">
                        {lamportsToSol(d.rentExemptMinLamports)} SOL
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {otherLegs.length > 0 && (
              <div className="rounded-lg bg-white/3 px-3 py-2.5 text-[11px] space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/35">
                  Also paid this run
                </p>
                {otherLegs.map((leg) => (
                  <Row
                    key={leg.mint}
                    label="To agents (net)"
                    value={fmtMint(leg.amount, leg.mint)}
                  />
                ))}
                <p className="text-[10px] text-white/30 leading-relaxed">
                  Paid from each asset&apos;s own treasury balance, plus the
                  same{" "}
                  {(d.feeBps / 100).toFixed(d.feeBps % 100 === 0 ? 0 : 2)}% fee.
                  The coverage check above only covers {d.asset.symbol}.
                </p>
              </div>
            )}

            {insufficient && (
              <div className="rounded-lg bg-amber-500/10 border border-amber-400/25 px-3 py-2 text-[11px] text-amber-100 leading-relaxed">
                <strong className="font-semibold">
                  Treasury can&apos;t cover this payout.
                </strong>{" "}
                {isSolActive ? (
                  <>
                    Balance is {lamportsToSol(d.treasuryBalanceLamports)} SOL but
                    only {lamportsToSol(d.usableBalanceLamports)} SOL is usable
                    (Solana protects {lamportsToSol(d.rentExemptMinLamports)} SOL
                    rent-exempt minimum). Need {lamportsToSol(grossNeeded)} SOL.
                    Top up the treasury before running.
                  </>
                ) : (
                  <>
                    {d.asset.symbol} balance is{" "}
                    {fmtAsset(d.treasuryAssetBalance, d.asset)} but this run
                    needs {fmtAsset(grossNeeded, d.asset)}. Send more{" "}
                    {d.asset.symbol} to the treasury before running.
                  </>
                )}
              </div>
            )}
          </>
        )}

        <p className="text-[10.5px] text-white/35 leading-relaxed">
          OCCA&apos;s operator key signs server-side — no wallet popup.
          Each payout is an on-chain tx, irreversible once confirmed.
          Uses one signature from your monthly auto-payout cap.
        </p>
      </div>
    </Modal>
  );
}

// ── Combined export — drop both into treasury-pane.tsx ────────────────────

export function TreasuryOperationsSection({
  companyId,
}: {
  companyId: string;
}) {
  return (
    <>
      <OperationsStatusCard companyId={companyId} />
      <RoutinePayoutButton companyId={companyId} />
    </>
  );
}
