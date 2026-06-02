"use client";

import { useCallback, useEffect } from "react";
import { Link2, Loader2, RefreshCw } from "lucide-react";
import type { AgentDTO } from "@occa/shared/types";
import { useBatchAnchorAgents } from "@/features/chain/hooks/use-batch-anchor-agents";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import { prettifyAnchorError } from "@/features/chain/lib/anchor-errors";

// Per-agent on-chain anchor CTA for non-CEO ready agents missing chain
// registration. Reuses the batch hook with a single agent id — the hook
// handles the `pending.length === 1` branch with one signTransaction
// call. Parent should key this on agent.id so switching agents resets
// the hook state instead of leaking prepRef across selections.
//
// Prepare runs only on the user's Sign click (not on mount) — Solana
// blockhashes have ~60s lifetime; auto-preparing earlier and waiting for
// the click would race the expiry. Once prepare resolves to
// `ready-to-sign` the effect chains signAndRegister immediately so the
// wallet popup appears without an extra round-trip.
//
// CEO is handled by a separate wizard (AnchorSetupModal) since it's a
// 3-phase flow that also anchors the company. This panel is non-CEO only.
export function AnchorAgentPanel({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const { stage, error, prepare, signAndRegister, reset } =
    useBatchAnchorAgents();
  const walletStatus = useAnchorWallet();

  const handleAnchor = useCallback(() => {
    if (walletStatus.kind !== "ready") return;
    if (stage !== "idle") return;
    void prepare({ companyId: agent.companyId ?? "", agentIds: [agent.id] });
  }, [walletStatus, stage, prepare, agent.companyId, agent.id]);

  useEffect(() => {
    if (stage !== "ready-to-sign") return;
    if (walletStatus.kind !== "ready") return;
    void signAndRegister({
      companyId: agent.companyId ?? "",
      wallet: walletStatus.wallet,
    });
  }, [stage, walletStatus, signAndRegister, agent.companyId]);

  useEffect(() => {
    if (stage !== "complete") return;
    void onReloadMe();
  }, [stage, onReloadMe]);

  const busy =
    stage === "preparing" ||
    stage === "awaiting-signature" ||
    stage === "deriving-keypairs" ||
    stage === "registering";

  const busyLabel =
    stage === "preparing"
      ? "Reserving on-chain slot…"
      : stage === "awaiting-signature"
        ? "Waiting for wallet signature…"
        : stage === "deriving-keypairs"
          ? "Deriving keypair…"
          : stage === "registering"
            ? "Submitting on-chain tx…"
            : null;

  const prettified = error ? prettifyAnchorError(error.code) : null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/4 px-4 py-3 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="size-8 shrink-0 rounded-full bg-cyan-400/15 flex items-center justify-center">
          <Link2 className="size-4 text-cyan-200" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-white/90">
            Anchor agent on Solana
          </div>
          <div className="text-[11px] text-white/55 mt-0.5">
            One signature derives an on-chain keypair and registers this
            agent in a single combined transaction. Your private key never
            leaves your wallet.
          </div>
        </div>
      </div>

      {error && prettified && (
        <div className="rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2.5 space-y-1.5">
          <div className="flex items-start gap-2">
            <p className="text-[11px] text-rose-200/95 leading-snug flex-1 min-w-0">
              {prettified.headline}
            </p>
            <span className="font-mono text-[10px] text-rose-300/80 bg-rose-500/15 px-1.5 py-0.5 rounded shrink-0">
              {error.code}
            </span>
          </div>
          <p className="text-[11px] text-white/65 leading-relaxed">
            {prettified.hint}
          </p>
        </div>
      )}

      {walletStatus.kind !== "ready" && walletStatus.kind !== "loading" && (
        <div className="text-[11px] text-amber-300/85 bg-amber-500/10 rounded-md px-2.5 py-1.5">
          {walletStatus.kind === "no-wallet"
            ? "Connect a Solana wallet to anchor this agent."
            : "Connected wallet doesn't match your OCCA identity. Reconnect with the original wallet."}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {error ? (
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold text-white transition-all cursor-pointer"
            style={{
              background: "linear-gradient(150deg, #0ea5e9 0%, #0369a1 100%)",
            }}
          >
            <RefreshCw className="size-3.5" />
            Retry
          </button>
        ) : (
          <button
            type="button"
            onClick={handleAnchor}
            disabled={busy || walletStatus.kind !== "ready"}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            style={{
              background:
                !busy && walletStatus.kind === "ready"
                  ? "linear-gradient(150deg, #0ea5e9 0%, #0369a1 100%)"
                  : "rgba(255,255,255,0.08)",
            }}
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {busyLabel}
              </>
            ) : (
              <>
                <Link2 className="size-3.5" />
                Anchor on Solana
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
