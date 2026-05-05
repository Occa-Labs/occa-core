"use client";

import { useEffect, useRef, useState } from "react";
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

interface HiringWindowProps {
  companyId: string;
  /** Fires after kickoff finishes (state → completed) — parent should
   *  refresh `me` and unmount this window. */
  onCompleted: () => void;
  /** Fires after kickoff/reset succeeds — parent should refresh `me`. */
  onReset: () => void;
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

export function HiringWindow({
  companyId,
  onCompleted,
  onReset,
}: HiringWindowProps) {
  const [agents, setAgents] = useState<KickoffAgentStatus[]>([]);
  const [phase, setPhase] =
    useState<KickoffStatusFrame["kickoffState"]>("provisioning");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // Batch on-chain anchoring runs AFTER kickoff finishes provisioning.
  // We hold completion (don't fire onCompleted) until the user either
  // anchors the team or explicitly skips — anchoring binds every hire
  // to a Solana keypair derived from one wallet signature.
  const anchor = useBatchAnchorAgents();
  const walletStatus = useAnchorWallet();
  const [anchorSkipped, setAnchorSkipped] = useState(false);
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
      ctrl.abort(new DOMException("HiringWindow unmount", "AbortError"));
  }, [companyId]);

  const ready = agents.filter((a) => a.provisioningState === "ready").length;
  const failed = agents.filter((a) => a.provisioningState === "failed").length;
  const total = agents.length;

  // Auto-prepare batch anchor as soon as kickoff finishes. Idempotent
  // server-side: re-running just returns the existing reservations.
  useEffect(() => {
    if (phase !== "completed") return;
    if (preparedRef.current) return;
    if (anchor.stage !== "idle") return;
    if (agents.length === 0) return;
    preparedRef.current = true;
    void anchor.prepare({
      companyId,
      agentIds: agents.map((a) => a.id),
    });
  }, [phase, agents, anchor, companyId]);

  // Once anchoring resolves (complete or skipped), forward to the parent.
  useEffect(() => {
    if (phase !== "completed") return;
    if (anchor.stage === "complete" || anchorSkipped) {
      onCompleted();
    }
  }, [phase, anchor.stage, anchorSkipped, onCompleted]);

  const subtitle = streamError
    ? "Stream error"
    : phase === "completed"
      ? anchor.stage === "complete" || anchorSkipped
        ? "Team ready — entering OCCA…"
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
      title="Hiring kickoff team"
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
                Each hire pairs a device key, restarts the gateway, and seeds
                their workspace files. ~30s per hire.
              </div>
            </div>
            <ProgressRing ready={ready} total={total || 1} failed={failed} />
          </div>
        </div>

        {/* Per-hire list */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2">
          {streamError && (
            <div className="text-[12px] text-red-300/85 bg-red-500/10 rounded-lg px-3 py-2">
              Couldn't subscribe to status stream: {streamError}
            </div>
          )}
          {agents.length === 0 && !streamError && (
            <div className="flex items-center gap-2 text-[12px] text-white/50 py-4">
              <Loader2 className="size-3.5 animate-spin" />
              Loading hires…
            </div>
          )}
          {agents.map((a) => (
            <HireCard key={a.id} agent={a} />
          ))}

          {/* Anchor-on-Solana CTA — only after kickoff completes. Skipped
           *  cleanly when there's nothing to anchor (totalNew === 0). */}
          {phase === "completed" && !anchorSkipped && (
            <AnchorPanel
              anchorStage={anchor.stage}
              anchorError={
                anchor.error
                  ? prettifyAnchorError(anchor.error.code).headline
                  : null
              }
              anchorTotal={anchor.totalNew}
              walletReady={walletStatus.kind === "ready"}
              walletStatus={walletStatus.kind}
              onSign={() => {
                if (walletStatus.kind !== "ready") return;
                void anchor.signAndRegister({
                  companyId,
                  wallet: walletStatus.wallet,
                });
              }}
              onSkip={() => setAnchorSkipped(true)}
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
              Stuck? Reset drops the hires + restarts the kickoff dialog.
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

function HireCard({ agent }: { agent: KickoffAgentStatus }) {
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

  return (
    <div
      className={`
        rounded-xl border px-3 py-2.5 flex items-center gap-3
        ${
          state === "failed"
            ? "bg-red-500/8 border-red-400/25"
            : state === "ready"
              ? "bg-emerald-500/8 border-emerald-400/25"
              : "bg-white/4 border-white/10"
        }
      `}
    >
      <div
        className={`
          size-9 shrink-0 rounded-full flex items-center justify-center
          text-[11px] font-semibold
          ${
            state === "ready"
              ? "bg-emerald-400/15 text-emerald-100"
              : state === "failed"
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
        <div className="text-[13px] font-medium text-white/90 truncate">
          {agent.name}
        </div>
        <div className="text-[11px] text-white/50 truncate">
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
// Renders a single inline CTA inside the HiringWindow once kickoff
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
  anchorError: string | null;
  anchorTotal: number;
  walletReady: boolean;
  walletStatus: "loading" | "no-wallet" | "mismatch" | "ready";
  onSign: () => void;
  onSkip: () => void;
  onRetry: () => void;
}) {
  // Don't render if there's literally nothing to anchor — saves the user
  // from a confusing "0 hires" CTA when prepare returned all already-
  // registered.
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
            {anchorTotal > 0 ? `all ${anchorTotal} hires` : "every hire"}. Your
            private key never leaves your wallet.
          </div>
        </div>
      </div>

      {anchorError && (
        <div className="text-[11px] text-red-300/85 bg-red-500/10 rounded-md px-2.5 py-1.5">
          {anchorError}
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
