"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, Link2, RefreshCw } from "lucide-react";
import type { UseOnboardingResult } from "@/hooks/use-onboarding";
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
  | "registering-agent";

const NARRATION = "One more step — let's anchor this on Solana.";
const TYPING_SPEED = 30;

// Sub-label rendered under the active step. Two variants per step:
// "busy" (work in flight) vs "idle" (waiting for the user to click).
const STEP_SUBLABEL_BUSY: Record<ProgressStage, string> = {
  "registering-company": "Building transaction…",
  "awaiting-signature": "Approve in your wallet to continue.",
  "registering-agent": "Confirming on Solana devnet…",
};

const STEP_SUBLABEL_IDLE: Record<ProgressStage, string> = {
  "registering-company":
    "We'll register your company on Solana. You'll sign once with your wallet.",
  "awaiting-signature": "Click below to approve in your wallet.",
  "registering-agent": "",
};

const STEPS: ReadonlyArray<{ key: ProgressStage; label: string }> = [
  { key: "registering-company", label: "Register company on-chain" },
  { key: "awaiting-signature", label: "Sign on-chain transaction" },
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

  // Mirror anchor.stage → onboarding state.
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

  // Both Phase A (registerCompany) and Phase B (signAndRegisterAgent)
  // call wallet.signTransaction now — they MUST originate from a user
  // gesture or external wallets silently no-op the popup. We removed
  // the auto-fire effect; the explicit Sign button drives both.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // Phase A+B trigger — invoked from button onClick.
  const onSignClick = async () => {
    if (walletStatus.kind !== "ready") return;
    if (!companyId || !agentId) return;
    // Run A first (idempotent server-side); only proceed to B if A
    // completed (companyPda cached on the hook).
    if (anchor.stage === "idle" || anchor.stage === "registering-company") {
      await anchor.registerCompany({
        companyId,
        wallet: walletStatus.wallet,
      });
    }
    // After Phase A, the hook is in `ready-to-sign`. Kick off Phase B.
    if (anchorRef.current.stage === "ready-to-sign") {
      await anchor.signAndRegisterAgent({
        agentId,
        wallet: walletStatus.wallet,
      });
    }
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
    // Both phases require user gesture now \u2014 don't auto-fire here. The
    // Sign button below will run A\u2192B in sequence.
  };

  const showError = isErrored || walletBlocker !== null;

  // Active step index — driven by the hook's stage, NOT the onboarding
  // status. The onboarding state is pre-initialized to
  // "registering-company" the moment we enter the anchor flow, which
  // made step #1 always look like it was in progress before the user
  // had even clicked Sign.
  const activeIdx: number = showError
    ? Math.max(
        0,
        STEPS.findIndex((s) => s.key === stageKey),
      )
    : anchor.stage === "registering-company"
      ? 0
      : anchor.stage === "ready-to-sign" ||
          anchor.stage === "awaiting-signature"
        ? 1
        : anchor.stage === "registering-agent"
          ? 2
          : anchor.stage === "complete"
            ? STEPS.length
            : 0; // idle → highlight first step as the call-to-action

  // Active step "mode" → which icon + sublabel + inline button to show.
  type ActiveMode = "idle" | "busy" | "awaiting-sign";
  const activeMode: ActiveMode = showError
    ? "idle"
    : anchor.stage === "registering-company" ||
        anchor.stage === "registering-agent"
      ? "busy"
      : anchor.stage === "awaiting-signature"
        ? "awaiting-sign"
        : "idle";

  const ceoName = onboarding.form.agentName || "your CEO";

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

            <div className="mt-4">
              <ol className="space-y-3.5">
                {STEPS.map((s, i) => {
                  const isDone = !showError && i < activeIdx;
                  const isActive = i === activeIdx && !showError;
                  const isErrorHere = showError && i === activeIdx;
                  const sublabel = isActive
                    ? activeMode === "busy"
                      ? STEP_SUBLABEL_BUSY[s.key]
                      : STEP_SUBLABEL_IDLE[s.key]
                    : "";
                  const showSignHere =
                    isActive &&
                    activeMode === "idle" &&
                    walletStatus.kind === "ready" &&
                    (anchor.stage === "idle" ||
                      anchor.stage === "ready-to-sign");

                  return (
                    <li key={s.key} className="flex gap-2.5">
                      <div className="pt-0.5 shrink-0">
                        {isDone ? (
                          <CheckIcon />
                        ) : isErrorHere ? (
                          <span className="w-3.5 h-3.5 rounded-full border-2 border-rose-400/80 inline-flex items-center justify-center text-[10px] text-rose-300/90">
                            ✕
                          </span>
                        ) : isActive && activeMode === "busy" ? (
                          <SpinnerIcon />
                        ) : isActive && activeMode === "awaiting-sign" ? (
                          <KeyRound className="w-3.5 h-3.5 text-amber-300/90 animate-pulse" />
                        ) : isActive ? (
                          <span className="w-3.5 h-3.5 rounded-full border-2 border-white/60" />
                        ) : (
                          <span className="w-3.5 h-3.5 rounded-full border border-white/15" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-xs leading-tight ${
                            isDone
                              ? "text-emerald-300/80"
                              : isErrorHere
                                ? "text-rose-300/90 font-medium"
                                : isActive
                                  ? "text-white/90 font-medium"
                                  : "text-white/40"
                          }`}
                        >
                          {s.label}
                        </div>

                        {sublabel && (
                          <p className="mt-1 text-[11px] text-white/55 leading-relaxed">
                            {sublabel}
                          </p>
                        )}

                        {isErrorHere && pretty && (
                          <div className="mt-1.5 space-y-1">
                            <div className="flex items-start gap-2">
                              <p className="text-[11px] text-rose-300/90 leading-snug flex-1 min-w-0">
                                {pretty.headline}
                              </p>
                              {errorCode && (
                                <span className="font-mono text-[10px] text-rose-400/70 bg-rose-500/10 px-1.5 py-0.5 rounded shrink-0">
                                  {errorCode}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-white/55 leading-relaxed">
                              {pretty.hint}
                            </p>
                          </div>
                        )}

                        {showSignHere && (
                          <div className="mt-2">
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={onSignClick}
                            >
                              <KeyRound className="size-3" />
                              Sign with wallet
                            </Button>
                          </div>
                        )}

                        {isErrorHere && (
                          <div className="mt-2">
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={onRetry}
                              disabled={walletStatus.kind === "loading"}
                            >
                              <RefreshCw className="size-3" />
                              Try again
                            </Button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>

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
                <p className="mt-3 text-[11px] text-white/45 leading-relaxed flex items-start gap-1.5">
                  <Link2 className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    Anchoring {ceoName} on Solana devnet — signed by your
                    wallet, OCCA never holds the private key.
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
