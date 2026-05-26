"use client";

import { useCallback, useEffect } from "react";
import { Check, Link2, Loader2, RefreshCw, X } from "lucide-react";
import type { AgentDTO, CompanyDTO } from "@occa/shared/types";
import { Modal } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAnchorIdentity } from "@/features/chain/hooks/use-anchor-identity";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import {
  prettifyAnchorError,
  type AnchorErrorCode,
} from "@/features/chain/lib/anchor-errors";

interface AnchorSetupModalProps {
  open: boolean;
  onClose: () => void;
  company: CompanyDTO;
  /** Must be the CEO agent — the 3-phase flow anchors company + this
   *  agent's identity + this agent's deployment in one wizard. */
  ceo: AgentDTO;
  /** Called after all 3 phases complete + before auto-close, so the
   *  parent can refresh `me` and re-render with the anchored state. */
  onComplete: () => Promise<void> | void;
}

type WizardStep = 1 | 2 | 3;

interface StepCopy {
  title: string;
  what: string;
  why: string;
  cost: string;
  cta: string;
}

const STEP_COPY: Record<WizardStep, StepCopy> = {
  1: {
    title: "Register company",
    what: "Create the CompanyAccount PDA on Solana that proves you own this company.",
    why: "Without this, the company exists only in your local browser DB. Ownership can't transfer to another device, and the treasury can't accept funds.",
    cost: "Cost: ~0.002 SOL devnet rent + 1 wallet signature.",
    cta: "Sign company",
  },
  2: {
    title: "Register identity",
    what: "Create a portable AgentIdentity PDA for your CEO.",
    why: "Identity is owner-scoped, not company-scoped. The same CEO can be re-deployed to other companies you own later without rebuilding their on-chain identity from scratch.",
    cost: "Cost: ~0.001 SOL devnet rent + 1 wallet signature.",
    cta: "Sign identity",
  },
  3: {
    title: "Register deployment",
    what: "Create the Deployment PDA linking the CEO's identity to this company.",
    why: "Records the agent's role (CEO) and reporting position on-chain. Required before this agent can receive treasury disbursements or have its task stream anchored daily.",
    cost: "Cost: ~0.001 SOL devnet rent + 1 wallet signature.",
    cta: "Sign deployment",
  },
};

function stageToStep(stage: ReturnType<typeof useAnchorIdentity>["stage"]): {
  step: WizardStep;
  busy: boolean;
} {
  switch (stage) {
    case "idle":
    case "registering-company":
      return { step: 1, busy: stage === "registering-company" };
    case "ready-to-sign-identity":
    case "registering-identity":
      return { step: 2, busy: stage === "registering-identity" };
    case "ready-to-sign":
    case "awaiting-signature":
    case "registering-agent":
      return {
        step: 3,
        busy: stage === "awaiting-signature" || stage === "registering-agent",
      };
    case "complete":
      return { step: 3, busy: false };
  }
}

export function AnchorSetupModal({
  open,
  onClose,
  company,
  ceo,
  onComplete,
}: AnchorSetupModalProps) {
  const anchor = useAnchorIdentity();
  const walletStatus = useAnchorWallet();

  const { step, busy } = stageToStep(anchor.stage);
  const complete = anchor.stage === "complete";

  // Refresh parent + auto-close shortly after the final phase confirms,
  // so the user sees the green success state before the modal slides out.
  useEffect(() => {
    if (!complete) return;
    void onComplete();
    const t = window.setTimeout(() => onClose(), 1100);
    return () => window.clearTimeout(t);
  }, [complete, onComplete, onClose]);

  // Reset hook state when the modal closes so a subsequent reopen
  // starts fresh (server idempotency advances through any completed
  // phases on first click).
  useEffect(() => {
    if (open) return;
    anchor.reset();
    // anchor.reset is stable (useCallback in the hook) — safe to omit
    // from deps to avoid an unintended reset on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSign = useCallback(async () => {
    if (walletStatus.kind !== "ready") return;
    const wallet = walletStatus.wallet;
    if (step === 1) {
      await anchor.registerCompany({ companyId: company.id, wallet });
      return;
    }
    if (step === 2) {
      await anchor.registerIdentity({ identityId: ceo.identityId, wallet });
      return;
    }
    if (step === 3) {
      await anchor.signAndRegisterAgent({ agentId: ceo.id, wallet });
      return;
    }
  }, [
    step,
    walletStatus,
    anchor,
    company.id,
    ceo.identityId,
    ceo.id,
  ]);

  const copy = STEP_COPY[step];
  const prettified = anchor.error
    ? prettifyAnchorError(anchor.error.code)
    : null;
  const walletGate = walletStatus.kind !== "ready"
    ? walletGateMessage(walletStatus.kind)
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Anchor on Solana"
      subtitle={`${company.name} · ${ceo.name} · CEO`}
      dismissable={!busy}
      width="min(560px, 92vw)"
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
          {complete ? (
            <Button variant="primary" size="sm" onClick={onClose}>
              <Check className="size-3" />
              Done
            </Button>
          ) : anchor.error ? (
            <Button variant="warning" size="sm" onClick={anchor.reset}>
              <RefreshCw className="size-3" />
              Retry {copy.title.toLowerCase()}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void onSign()}
              disabled={busy || walletStatus.kind !== "ready"}
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Link2 className="size-3" />
              )}
              {busy
                ? busyLabel(anchor.stage)
                : copy.cta}
            </Button>
          )}
        </div>
      }
    >
      <div className="px-5 py-4 flex flex-col gap-4">
        <Stepper currentStep={step} complete={complete} />

        {!complete && (
          <div className="flex flex-col gap-2.5">
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
                Step {step} of 3
              </p>
              <h3 className="mt-1 text-[14px] font-semibold text-white/95">
                {copy.title}
              </h3>
            </div>
            <p className="text-[12px] text-white/75 leading-relaxed">
              {copy.what}
            </p>
            <p className="text-[12px] text-white/55 leading-relaxed">
              {copy.why}
            </p>
            <p className="text-[11px] text-white/40">{copy.cost}</p>
          </div>
        )}

        {complete && (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-3 py-2.5 flex items-start gap-2">
            <Check className="size-4 text-emerald-300 mt-0.5 shrink-0" />
            <div>
              <p className="text-[12px] font-medium text-emerald-200">
                {company.name} and {ceo.name} are anchored on Solana.
              </p>
              <p className="mt-0.5 text-[11px] text-emerald-200/70">
                Treasury, payouts, and daily anchors are now available.
              </p>
            </div>
          </div>
        )}

        {anchor.error && prettified && (
          <ErrorBanner code={anchor.error.code} pretty={prettified} />
        )}

        {walletGate && (
          <Alert variant="warning">
            <p className="text-[11px]">{walletGate}</p>
          </Alert>
        )}
      </div>
    </Modal>
  );
}

function Stepper({
  currentStep,
  complete,
}: {
  currentStep: WizardStep;
  complete: boolean;
}) {
  const steps: { idx: WizardStep; label: string }[] = [
    { idx: 1, label: "Company" },
    { idx: 2, label: "Identity" },
    { idx: 3, label: "Deployment" },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {steps.map((s, i) => {
        const done = complete ? true : currentStep > s.idx;
        const active = !complete && currentStep === s.idx;
        return (
          <div key={s.idx} className="flex items-center gap-1.5 flex-1">
            <div className="flex items-center gap-1.5">
              <div
                className={`
                  size-5 rounded-full flex items-center justify-center
                  text-[10px] font-semibold transition-colors
                  ${
                    done
                      ? "bg-emerald-400 text-black"
                      : active
                        ? "bg-amber-300 text-black"
                        : "bg-white/8 text-white/45"
                  }
                `}
              >
                {done ? <Check className="size-3" /> : s.idx}
              </div>
              <span
                className={`text-[11px] font-medium ${
                  done
                    ? "text-emerald-200"
                    : active
                      ? "text-amber-100"
                      : "text-white/40"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-px ${
                  done ? "bg-emerald-400/40" : "bg-white/8"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ErrorBanner({
  code,
  pretty,
}: {
  code: AnchorErrorCode;
  pretty: { headline: string; hint: string };
}) {
  return (
    <div className="rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        <p className="text-[12px] text-rose-100 font-medium leading-snug flex-1 min-w-0">
          {pretty.headline}
        </p>
        <span className="font-mono text-[10px] text-rose-300/80 bg-rose-500/15 px-1.5 py-0.5 rounded shrink-0">
          {code}
        </span>
      </div>
      <p className="text-[11px] text-rose-200/80 leading-relaxed">
        {pretty.hint}
      </p>
    </div>
  );
}

function busyLabel(stage: ReturnType<typeof useAnchorIdentity>["stage"]): string {
  switch (stage) {
    case "registering-company":
      return "Registering company…";
    case "registering-identity":
      return "Registering identity…";
    case "awaiting-signature":
      return "Waiting for signature…";
    case "registering-agent":
      return "Registering deployment…";
    default:
      return "Working…";
  }
}

function walletGateMessage(kind: string): string {
  if (kind === "no-wallet") return "Connect a Solana wallet to continue.";
  if (kind === "mismatch")
    return "Connected wallet doesn't match your OCCA identity. Reconnect with the original wallet.";
  if (kind === "loading") return "Loading wallet…";
  return "Wallet not ready.";
}
