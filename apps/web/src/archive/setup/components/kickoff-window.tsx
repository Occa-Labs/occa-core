"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Check,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Link2,
} from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { surface } from "@/components/ui/tokens";
import {
  ApiError,
  kickoffApi,
  type KickoffAgentStatus,
  type KickoffStatusFrame,
} from "@/lib/api";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { useBatchAnchorAgents } from "@/features/chain/hooks/use-batch-anchor-agents";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import { prettifyAnchorError } from "@/features/chain/lib/anchor-errors";

interface KickoffWindowProps {
  companyId: string;
  /** Fires after kickoff finishes (state → completed) — parent should
   *  refresh `me` and unmount this window. */
  onCompleted: () => void;
  /** Fires after kickoff/reset succeeds — parent should refresh `me`. */
  onReset: () => void;
  /** User clicked "Skip for now" on the AnchorPanel. Parent persists the
   *  decision per-company and routes the user into OS with a banner. */
  onAnchorSkip: () => void;
}

const ROLE_ABBREVIATIONS: Record<string, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  coo: "COO",
  cfo: "CFO",
  cpo: "CPO",
  cro: "CRO",
  cco: "CCO",
  chro: "CHRO",
  ciso: "CISO",
  sdr: "SDR",
};

function roleLabel(slug: string): string {
  const abbr = ROLE_ABBREVIATIONS[slug.toLowerCase()];
  if (abbr) return abbr;
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function KickoffWindow({
  companyId,
  onCompleted,
  onReset,
  onAnchorSkip,
}: KickoffWindowProps) {
  const [agents, setAgents] = useState<KickoffAgentStatus[]>([]);
  const [phase, setPhase] =
    useState<KickoffStatusFrame["kickoffState"]>("provisioning");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // Batch on-chain anchoring runs AFTER kickoff finishes provisioning.
  // We hold completion (don't fire onCompleted) until the anchor is
  // actually broadcast. The "Skip for now" path is hoisted to the
  // parent (see onAnchorSkip) so the decision persists across refresh
  // and a reminder banner can be rendered in OsShell.
  const anchor = useBatchAnchorAgents();
  const walletStatus = useAnchorWallet();
  const preparedRef = useRef(false);

  useEffect(() => {
    const ctrl = new AbortController();

    kickoffApi
      .streamStatus(
        companyId,
        (frame) => {
          setAgents(frame.agents.filter((a) => a.role !== CEO_ROLE));
          setPhase(frame.kickoffState);
        },
        () => {
          /* completion handled by the anchor-gate effect below */
        },
        ctrl.signal,
      )
      .catch((err) => {
        if (
          ctrl.signal.aborted ||
          err?.name === "AbortError" ||
          err?.code === "ABORT_ERR"
        ) {
          return;
        }
        setStreamError(
          err instanceof Error ? err.message : "status_stream_failed",
        );
      });

    return () =>
      ctrl.abort(new DOMException("KickoffWindow unmount", "AbortError"));
  }, [companyId]);

  const ready = agents.filter((a) => a.provisioningState === "ready").length;
  const failed = agents.filter((a) => a.provisioningState === "failed").length;
  const total = agents.length;

  // Just-in-time prepare — runs when the user clicks Anchor, NOT on
  // kickoff completion. Auto-preparing too early leaves the prepared
  // tx sitting around with a Solana blockhash that lives ~60s; if the
  // user takes any time to read the panel before clicking sign, the
  // blockhash expires and confirm fails with `BlockhashNotFound`.
  const prepareIfNeeded = useCallback(async () => {
    if (anchor.stage !== "idle") return;
    if (agents.length === 0) return;
    preparedRef.current = true;
    await anchor.prepare({
      companyId,
      agentIds: agents.map((a) => a.id),
    });
  }, [anchor, agents, companyId]);

  // Once anchoring resolves (broadcast complete), forward to the parent.
  // The skip path no longer routes through this effect — it goes
  // straight to onAnchorSkip in the AnchorPanel handler below.
  useEffect(() => {
    if (phase !== "completed") return;
    if (anchor.stage === "complete") {
      onCompleted();
    }
  }, [phase, anchor.stage, onCompleted]);

  const subtitle = streamError
    ? "Stream error"
    : phase === "completed"
      ? anchor.stage === "complete"
        ? "Team ready. Entering OCCA…"
        : "Team provisioned · anchor on Solana to finish"
      : `${ready}/${total || "?"} ready${failed > 0 ? ` · ${failed} failed` : ""}`;

  const doReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await kickoffApi.reset(companyId);
      onReset();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `api_${err.status}`
          : err instanceof Error
            ? err.message
            : "reset_failed";
      setResetError(msg);
    } finally {
      setResetting(false);
      setConfirmingReset(false);
    }
  };

  return (
    <AppWindow
      title="Deploying kickoff team"
      subtitle={subtitle}
      defaultSize={{ w: 640, h: 580 }}
      disableClose
    >
      <div className="flex flex-col h-full min-h-0">
        {/* Progress strip */}
        <div className="px-5 py-3 border-b border-white/8">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[12px] text-white/85 font-medium">
                {phase === "provisioning"
                  ? "Provisioning team in OpenClaw"
                  : phase === "completed"
                    ? "Team ready"
                    : "Setting up"}
              </div>
              <div className="text-[11px] text-white/50 mt-0.5">
                Each deployment pairs a device key, restarts the gateway, and seeds
                their workspace files. ~30s per deployment.
              </div>
            </div>
            <ProgressRing ready={ready} total={total || 1} failed={failed} />
          </div>
        </div>

        {/* Per-deployment list */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2">
          {streamError && (
            <div className="text-[12px] text-red-300/85 bg-red-500/10 rounded-lg px-3 py-2">
              Couldn't subscribe to status stream: {streamError}
            </div>
          )}
          {agents.length === 0 && !streamError && (
            <div className="flex items-center gap-2 text-[12px] text-white/50 py-4">
              <Loader2 className="size-3.5 animate-spin" />
              Loading deployments…
            </div>
          )}
          {agents.map((a) => (
            <DeploymentCard key={a.id} agent={a} />
          ))}

          {/* Anchor-on-Solana CTA — shown after kickoff completes. Skip
           *  is hoisted to the parent so the decision persists across
           *  refresh and OsShell can render a reminder banner. */}
          {phase === "completed" && (
            <AnchorPanel
              anchorStage={anchor.stage}
              anchorError={
                anchor.error
                  ? {
                      code: anchor.error.code,
                      ...prettifyAnchorError(anchor.error.code),
                    }
                  : null
              }
              anchorTotal={anchor.totalNew}
              walletReady={walletStatus.kind === "ready"}
              walletStatus={walletStatus.kind}
              onSign={async () => {
                if (walletStatus.kind !== "ready") return;
                // Prepare just-in-time so the Solana blockhash hasn't
                // expired by the time we submit. If prepare already ran
                // (e.g. retry path), this is a no-op via the stage gate.
                await prepareIfNeeded();
                await anchor.signAndRegister({
                  companyId,
                  wallet: walletStatus.wallet,
                });
              }}
              onSkip={onAnchorSkip}
              onRetry={() => {
                anchor.reset();
                preparedRef.current = false;
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/8 px-5 py-3 flex flex-col gap-2">
          {resetError && (
            <div className="text-[11px] text-red-300/85">
              Reset failed: {resetError}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-white/45">
              Stuck? Reset drops the deployments + restarts the kickoff dialog.
            </span>
            {!confirmingReset ? (
              <Button
                size="sm"
                variant="warning"
                onClick={() => setConfirmingReset(true)}
              >
                <RotateCcw className="size-3" />
                Reset kickoff
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="warning"
                  onClick={() => void doReset()}
                  disabled={resetting}
                >
                  {resetting ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3" />
                  )}
                  Confirm reset
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfirmingReset(false)}
                  disabled={resetting}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

function ProgressRing({
  ready,
  total,
  failed,
}: {
  ready: number;
  total: number;
  failed: number;
}) {
  const settled = ready + failed;
  const pct = Math.round((settled / total) * 100);
  const stroke =
    failed > 0 ? "#ef4444" : ready === total ? "#10b981" : "#5fdcff";
  return (
    <div className="relative size-12 shrink-0">
      <svg viewBox="0 0 36 36" className="size-12 -rotate-90">
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="3"
        />
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke={stroke}
          strokeWidth="3"
          strokeDasharray={`${(pct / 100) * 87.96} 87.96`}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-white/85">
        {ready}/{total}
      </div>
    </div>
  );
}

function DeploymentCard({ agent }: { agent: KickoffAgentStatus }) {
  const state = agent.provisioningState;
  const variant: BadgeVariant =
    state === "ready" ? "success" : state === "failed" ? "error" : "default";

  const stateText =
    state === "ready"
      ? "Ready"
      : state === "failed"
        ? "Failed"
        : state === "provisioning"
          ? "Provisioning…"
          : "Pending";

  const stateIcon =
    state === "ready" ? (
      <Check className="size-3" />
    ) : state === "failed" ? (
      <AlertTriangle className="size-3" />
    ) : (
      <Loader2 className="size-3 animate-spin" />
    );

  const initials = agent.name
    .split(/\s+/)
    .map((n) => n.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const isReady = state === "ready";
  const isFailed = state === "failed";
  return (
    <div
      className={`
        rounded-xl px-3 py-2.5 flex items-center gap-3
        ${
          isFailed
            ? "bg-red-500/8 border border-red-400/25"
            : isReady
              ? ""
              : "bg-white/4 border border-white/10"
        }
      `}
      style={isReady ? surface.base : undefined}
    >
      <div
        className={`
          size-9 shrink-0 rounded-full flex items-center justify-center
          text-[11px] font-semibold
          ${
            isReady
              ? "bg-white/10 text-white"
              : isFailed
                ? "bg-red-400/15 text-red-100"
                : "bg-white/8 text-white/70"
          }
        `}
      >
        {state === "provisioning" || state === "pending" ? (
          <Sparkles className="size-4" />
        ) : (
          initials
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div
          className={`text-[13px] font-medium truncate ${
            isReady ? "text-white" : "text-white/90"
          }`}
        >
          {agent.name}
        </div>
        <div
          className={`text-[11px] truncate ${
            isReady ? "text-white/55" : "text-white/50"
          }`}
        >
          {roleLabel(agent.role)}
        </div>
        {agent.provisioningError && (
          <div className="text-[11px] text-red-300/80 mt-0.5 truncate">
            {agent.provisioningError}
          </div>
        )}
      </div>

      <Badge variant={variant} size="sm">
        {stateIcon}
        <span className="leading-none">{stateText}</span>
      </Badge>
    </div>
  );
}

// ── Anchor-on-Solana panel (post-kickoff) ─────────────────────────────────
//
// Renders a single inline CTA inside the KickoffWindow once kickoff
// finishes. Captures one wallet signature → hook derives N keypairs →
// server batches register_agent into a single (or chunked) tx.
//
// Click handlers are passed in from the parent so all the hook + wallet
// state lives in one place upstream.
function AnchorPanel({
  anchorStage,
  anchorError,
  anchorTotal,
  walletReady,
  walletStatus,
  onSign,
  onSkip,
  onRetry,
}: {
  anchorStage:
    | "idle"
    | "preparing"
    | "ready-to-sign"
    | "awaiting-signature"
    | "deriving-keypairs"
    | "registering"
    | "complete";
  anchorError: { code: string; headline: string; hint: string } | null;
  anchorTotal: number;
  walletReady: boolean;
  walletStatus: "loading" | "no-wallet" | "mismatch" | "ready";
  onSign: () => void;
  onSkip: () => void;
  onRetry: () => void;
}) {
  // Don't render if there's literally nothing to anchor — saves the user
  // from a confusing "0 deployments" CTA when prepare returned all
  // already-registered.
  if (anchorStage === "complete") {
    return (
      <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/8 px-4 py-3 flex items-center gap-3">
        <Link2 className="size-4 text-emerald-300/85" />
        <div className="flex-1 text-[12px] text-emerald-100/90">
          Team anchored on Solana.
        </div>
      </div>
    );
  }

  const busy =
    anchorStage === "preparing" ||
    anchorStage === "awaiting-signature" ||
    anchorStage === "deriving-keypairs" ||
    anchorStage === "registering";

  const busyLabel =
    anchorStage === "preparing"
      ? "Reserving on-chain slots…"
      : anchorStage === "awaiting-signature"
        ? "Waiting for wallet signature…"
        : anchorStage === "deriving-keypairs"
          ? "Deriving keypairs…"
          : anchorStage === "registering"
            ? "Submitting on-chain tx…"
            : null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/4 px-4 py-3 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="size-8 shrink-0 rounded-full bg-cyan-400/15 flex items-center justify-center">
          <Link2 className="size-4 text-cyan-200" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-white/90">
            Anchor team on Solana
          </div>
          <div className="text-[11px] text-white/55 mt-0.5">
            One signature derives an on-chain keypair for{" "}
            {anchorTotal > 0 ? `all ${anchorTotal} deployments` : "every deployment"}. Your
            private key never leaves your wallet.
          </div>
        </div>
      </div>

      {anchorError && (
        <div className="rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2.5 space-y-1.5">
          <div className="flex items-start gap-2">
            <p className="text-[11px] text-rose-200/95 leading-snug flex-1 min-w-0">
              {anchorError.headline}
            </p>
            <span className="font-mono text-[10px] text-rose-300/80 bg-rose-500/15 px-1.5 py-0.5 rounded shrink-0">
              {anchorError.code}
            </span>
          </div>
          <p className="text-[11px] text-white/65 leading-relaxed">
            {anchorError.hint}
          </p>
        </div>
      )}

      {!walletReady && walletStatus !== "loading" && (
        <div className="text-[11px] text-amber-300/85 bg-amber-500/10 rounded-md px-2.5 py-1.5">
          {walletStatus === "no-wallet"
            ? "Connect a Solana wallet to anchor."
            : "Wallet doesn't match the one bound to your account."}
        </div>
      )}

      <div className="flex items-center gap-2 justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={onSkip}
          disabled={busy}
          title="You can anchor later from settings."
        >
          Skip for now
        </Button>
        {anchorError ? (
          <Button size="sm" variant="primary" onClick={onRetry}>
            <RotateCcw className="size-3" />
            Retry
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={onSign}
            disabled={busy || !walletReady}
          >
            {busy ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                {busyLabel}
              </>
            ) : (
              <>
                <Link2 className="size-3" />
                Anchor on Solana
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
