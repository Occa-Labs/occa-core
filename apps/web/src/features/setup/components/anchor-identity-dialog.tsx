"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, Link2, RefreshCw } from "lucide-react";
import type { UseOnboardingResult } from "@/hooks/use-onboarding";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SpeakerBadge } from "@/components/ui/speaker-badge";
import { useAnchorIdentity } from "@/features/chain/hooks/use-anchor-identity";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import {
  type AnchorErrorCode,
  prettifyAnchorError,
} from "@/features/chain/lib/anchor-errors";

interface AnchorIdentityDialogProps {
  onboarding: UseOnboardingResult;
}

type ProgressStage =
  | "registering-company"
  | "awaiting-signature"
  | "deriving-keypair"
  | "registering-agent";

const NARRATION = "One more step — let's anchor this on Solana.";
const TYPING_SPEED = 30;

const STAGE_LABEL: Record<ProgressStage, string> = {
  "registering-company": "Registering company on-chain…",
  "awaiting-signature": "Waiting for your wallet signature…",
  "deriving-keypair": "Deriving the agent's keypair…",
  "registering-agent": "Registering agent on-chain…",
};

const STEPS: ReadonlyArray<{ key: ProgressStage; label: string }> = [
  { key: "registering-company", label: "Register company on-chain" },
  { key: "awaiting-signature", label: "Sign derivation message" },
  { key: "deriving-keypair", label: "Derive agent keypair" },
  { key: "registering-agent", label: "Register agent on-chain" },
];

function CheckIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 text-emerald-400 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <div className="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-white/70 animate-spin shrink-0" />
  );
}

/**
 * Phase B (on-chain anchor) wizard step.
 *
 * Architecture:
 *   • `useAnchorWallet` resolves the Solana wallet (or returns a non-ready
 *     status the user can act on).
 *   • `useAnchorIdentity` is wallet-agnostic — it accepts the resolved
 *     wallet and runs the A→B flow.
 *   • The dialog is the orchestrator: it auto-runs `anchor.run` ONLY when
 *     wallet status is `ready` AND onboarding is in `anchoring` AND the
 *     anchor hook is idle.
 *
 * z-50 (not z-100) so Privy's signature modal (which uses higher z) is
 * never visually trapped behind us.
 */
export function AnchorIdentityDialog({
  onboarding,
}: AnchorIdentityDialogProps) {
  const status = onboarding.status;
  const walletStatus = useAnchorWallet();
  const anchor = useAnchorIdentity();
  const ranKeyRef = useRef<string | null>(null);

  const [visible, setVisible] = useState(false);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const skipRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    setDisplayedText("");
    setIsTyping(true);
    skipRef.current = false;
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) {
        setDisplayedText(NARRATION);
        setIsTyping(false);
        clearInterval(id);
        return;
      }
      i++;
      setDisplayedText(NARRATION.slice(0, i));
      if (i >= NARRATION.length) {
        setIsTyping(false);
        clearInterval(id);
      }
    }, TYPING_SPEED);
    return () => clearInterval(id);
  }, []);

  const active =
    status.kind === "anchoring" || status.kind === "anchor-error"
      ? status
      : null;
  const companyId = active?.company.id ?? null;
  const agentId = active?.agentId ?? null;

  // Pin onboarding callbacks to a ref so effects below don't re-fire when
  // the onboarding object identity changes on every parent render.
  const onboardingRef = useRef(onboarding);
  onboardingRef.current = onboarding;

  // Mirror anchor.stage → onboarding state. We map ready-to-sign back to
  // awaiting-signature so onboarding state machine doesn't need a new key.
  useEffect(() => {
    const ob = onboardingRef.current;
    if (ob.status.kind !== "anchoring") return;
    if (anchor.stage === "registering-company") {
      if (ob.status.stage !== "registering-company") {
        ob.setAnchorStage("registering-company");
      }
    } else if (
      anchor.stage === "ready-to-sign" ||
      anchor.stage === "awaiting-signature"
    ) {
      if (ob.status.stage !== "awaiting-signature") {
        ob.setAnchorStage("awaiting-signature");
      }
    } else if (anchor.stage === "deriving-keypair") {
      if (ob.status.stage !== "deriving-keypair") {
        ob.setAnchorStage("deriving-keypair");
      }
    } else if (anchor.stage === "registering-agent") {
      if (ob.status.stage !== "registering-agent") {
        ob.setAnchorStage("registering-agent");
      }
    }
  }, [anchor.stage]);

  // Success → flip onboarding to complete.
  useEffect(() => {
    const ob = onboardingRef.current;
    if (ob.status.kind !== "anchoring") return;
    if (anchor.stage === "complete" && anchor.result) {
      ob.markAnchored(ob.status.company);
    }
  }, [anchor.stage, anchor.result]);

  // Error from hook → show retry UI.
  useEffect(() => {
    const ob = onboardingRef.current;
    if (ob.status.kind !== "anchoring") return;
    if (anchor.error) {
      ob.markAnchorError({
        stage: anchor.error.stage,
        message: anchor.error.code,
      });
    }
  }, [anchor.error]);

  // Auto-run Phase A only. Phase B requires a user gesture (button click)
  // — external Solana wallets like Phantom silently no-op signMessage
  // requests originating from useEffect-driven calls.
  //
  // We do NOT gate on `status.stage` here — the persisted onboarding state
  // can be ahead of the hook (e.g. previous attempt left it on
  // `awaiting-signature`). Server `registerCompany` is idempotent so
  // re-running Phase A on resume is safe and necessary to refill the
  // hook's in-memory companyPda before Phase B can fire.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useEffect(() => {
    if (status.kind !== "anchoring") {
      ranKeyRef.current = null;
      return;
    }
    if (!companyId || !agentId) return;
    if (anchorRef.current.stage !== "idle") return;

    const key = `A:${companyId}`;
    if (ranKeyRef.current === key) return;
    ranKeyRef.current = key;

    console.log("[anchor-dialog] auto-running Phase A", {
      companyId,
      onboardingStage: status.kind === "anchoring" ? status.stage : null,
    });
    void anchorRef.current.registerCompany(companyId);
  }, [status, companyId, agentId, anchor.stage]);

  // Phase B trigger — invoked from button onClick (preserves user
  // gesture across the await chain so the wallet popup actually opens).
  const onSignClick = () => {
    if (walletStatus.kind !== "ready") return;
    if (!agentId) return;
    void anchor.signAndRegisterAgent({
      agentId,
      wallet: walletStatus.wallet,
    });
  };

  if (!active) return null;

  // ── Determine what to render ───────────────────────────────────────
  const isErrored = status.kind === "anchor-error";

  // Wallet-level blockers take precedence over flow stages — the user
  // can't sign without a wallet.
  let walletBlocker: AnchorErrorCode | null = null;
  if (!isErrored) {
    if (walletStatus.kind === "loading") walletBlocker = "wallet_not_ready";
    else if (walletStatus.kind === "no-wallet")
      walletBlocker = "wallet_not_connected";
    else if (walletStatus.kind === "mismatch")
      walletBlocker = "wallet_mismatch";
  }

  const stageKey: ProgressStage = isErrored
    ? ((status as Extract<typeof status, { kind: "anchor-error" }>)
        .stage as ProgressStage)
    : ((status as Extract<typeof status, { kind: "anchoring" }>)
        .stage as ProgressStage);

  const errorCode: AnchorErrorCode | null = isErrored
    ? ((status as Extract<typeof status, { kind: "anchor-error" }>)
        .message as AnchorErrorCode)
    : walletBlocker;

  const pretty = errorCode ? prettifyAnchorError(errorCode) : null;

  const onRetry = () => {
    anchor.reset();
    ranKeyRef.current = null;
    if (status.kind === "anchor-error") {
      onboarding.retryAnchor();
    }
    // Restart from Phase A. Phase B will need another click.
    if (companyId) {
      void anchor.registerCompany(companyId);
    }
  };

  // Show the explicit Sign button when we're between Phase A and Phase B.
  const showSignButton =
    !isErrored &&
    !walletBlocker &&
    anchor.stage === "ready-to-sign" &&
    walletStatus.kind === "ready";

  const currentIdx = STEPS.findIndex((s) => s.key === stageKey);
  const ceoName = onboarding.form.agentName || "your CEO";
  const showError = isErrored || walletBlocker !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center pointer-events-none"
      onClick={() => {
        if (isTyping) skipRef.current = true;
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-700"
        style={{
          opacity: visible ? 1 : 0,
          background:
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.28) 100%)",
        }}
      />
      <div className="relative w-full max-w-2xl mx-4 mb-8 pointer-events-auto">
        {visible && (
          <Card
            spotlight
            padding="lg"
            className="relative animate-in fade-in duration-500"
          >
            <div className="absolute top-0 left-6 -translate-y-1/2 z-10">
              <SpeakerBadge name="Jia" />
            </div>

            <div className="mt-2 min-h-12 flex items-start">
              <p className="text-sm text-white/90 leading-relaxed">
                {displayedText}
                {isTyping && (
                  <span className="inline-block w-0.5 h-4 bg-white/60 ml-0.5 animate-pulse align-middle" />
                )}
              </p>
            </div>

            <div className="mt-4 space-y-1.5">
              <div className="flex items-center gap-2">
                {showError ? (
                  <span className="w-3.5 h-3.5 text-red-400 text-xs shrink-0">
                    ✕
                  </span>
                ) : stageKey === "awaiting-signature" ? (
                  <KeyRound className="w-3.5 h-3.5 text-amber-300/90 shrink-0 animate-pulse" />
                ) : (
                  <SpinnerIcon />
                )}
                <span
                  className="text-xs"
                  style={{
                    color: showError
                      ? "rgba(248,113,113,0.9)"
                      : stageKey === "awaiting-signature"
                        ? "rgba(253,224,71,0.9)"
                        : "rgba(255,255,255,0.55)",
                  }}
                >
                  {showError
                    ? (pretty?.headline ?? "Anchoring failed.")
                    : STAGE_LABEL[stageKey]}
                </span>
              </div>

              <ol className="mt-3 space-y-1.5">
                {STEPS.map((s, i) => {
                  const done = !showError && i < currentIdx;
                  const isCurrent = i === currentIdx;
                  return (
                    <li
                      key={s.key}
                      className={`flex items-center gap-2 text-xs ${
                        isCurrent
                          ? "text-white/85"
                          : done
                            ? "text-emerald-300/80"
                            : "text-white/40"
                      }`}
                    >
                      {done ? (
                        <CheckIcon />
                      ) : isCurrent ? (
                        showError ? (
                          <span className="w-3.5 h-3.5 rounded-full border-2 border-rose-400/80 shrink-0" />
                        ) : s.key === "awaiting-signature" ? (
                          <KeyRound className="w-3.5 h-3.5 text-amber-300/90 shrink-0" />
                        ) : (
                          <SpinnerIcon />
                        )
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0" />
                      )}
                      <span>{s.label}</span>
                    </li>
                  );
                })}
              </ol>

              {showError && pretty && (
                <Alert variant="error" className="mt-3" icon={null}>
                  <div className="flex items-start gap-2">
                    <p className="text-xs font-semibold text-red-300 flex-1 min-w-0 leading-snug">
                      {pretty.headline}
                    </p>
                    {errorCode && (
                      <span className="font-mono text-[10px] text-red-400/70 bg-red-500/10 px-1.5 py-0.5 rounded shrink-0">
                        {errorCode}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed">
                    {pretty.hint}
                  </p>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={onRetry}
                      disabled={walletStatus.kind === "loading"}
                    >
                      <RefreshCw className="size-3" />
                      Retry
                    </Button>
                  </div>
                </Alert>
              )}

              {showSignButton && (
                <div className="mt-3">
                  <Button variant="primary" size="sm" onClick={onSignClick}>
                    <KeyRound className="size-3" />
                    Sign with wallet
                  </Button>
                </div>
              )}

              {/* Debug strip — visible regardless of console filters. */}
              <div className="mt-3 font-mono text-[10px] text-white/40 border border-white/10 rounded px-2 py-1 leading-relaxed">
                <div>
                  hook.stage=
                  <span className="text-white/70">{anchor.stage}</span> wallet=
                  <span className="text-white/70">{walletStatus.kind}</span>
                  {walletStatus.kind === "ready" &&
                    `(${walletStatus.wallet.address.slice(0, 4)}…${walletStatus.wallet.address.slice(-4)})`}
                </div>
                <div>
                  onboarding.stage=
                  <span className="text-white/70">
                    {status.kind === "anchoring" ? status.stage : status.kind}
                  </span>
                  {anchor.error && (
                    <span className="text-red-300/80">
                      {" "}
                      err={anchor.error.code}@{anchor.error.stage}
                    </span>
                  )}
                </div>
              </div>

              {!showError && (
                <p className="mt-2 text-[11px] text-white/45 leading-relaxed flex items-start gap-1.5">
                  <Link2 className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    Anchoring {ceoName} on Solana devnet — keypair derived in
                    your browser, OCCA never sees the private key.
                  </span>
                </p>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
