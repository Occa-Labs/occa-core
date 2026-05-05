"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, Info, Pencil, RefreshCw } from "lucide-react";
import type { UseOnboardingResult } from "@/hooks/use-onboarding";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { SpeakerBadge } from "@/components/ui/speaker-badge";
import { usePairingTimer } from "@/hooks/use-pairing-timer";
import { DevicePairingHelp } from "./device-pairing-help";

interface SetupProgressDialogProps {
  onboarding: UseOnboardingResult;
  onRetry: () => void;
}

const NARRATION_DEFAULT = "Watch this — just a second.";
const NARRATION_PAIRING = "Your turn — let's get OCCA approved in OpenClaw.";
const TYPING_SPEED = 30;

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

function prettifyError(code: string): { headline: string; hint: string } {
  switch (code) {
    case "company_already_exists":
      return {
        headline: "Company already exists.",
        hint: "Server rejected the launch — a company is already bound to this wallet. Reload to continue.",
      };
    case "adapter_probe_failed":
      return {
        headline: "Adapter probe failed during launch.",
        hint: "Gateway handshake did not complete. Verify the URL and API key still resolve.",
      };
    case "gateway_unreachable":
      return {
        headline: "Gateway unreachable.",
        hint: "Server could not open a connection to the gateway host.",
      };
    case "device_pairing_required":
      return {
        headline: "One-time device approval needed.",
        hint: "Auto-pairing was attempted but the gateway requires manual approval for the first device. Open the OpenClaw control UI, approve the pending pair request, then click Retry.",
      };
    case "gateway_unauthorized":
      return {
        headline: "Gateway auth rejected.",
        hint: "API key was not accepted by the OpenClaw gateway.",
      };
    case "gateway_provision_failed":
      return {
        headline: "Gateway provisioning failed.",
        hint: "The OpenClaw side returned an error while creating the agent.",
      };
    case "gateway_restart_timeout":
      return {
        headline: "Gateway didn't come back in time.",
        hint: "OpenClaw restarted to apply the agent config but did not reconnect within 30s. Verify the gateway is healthy and retry.",
      };
    case "openclaw_agent_id_conflict":
      return {
        headline: "Agent id already taken on gateway.",
        hint: "An OpenClaw agent with this id exists already — try retrying so a fresh id is picked.",
      };
    case "network_error":
      return {
        headline: "Network error.",
        hint: "Could not reach the OCCA server — check connectivity and that the backend is running.",
      };
    default:
      return {
        headline: "Launch failed.",
        hint: code.replace(/_/g, " "),
      };
  }
}

export function SetupProgressDialog({
  onboarding,
  onRetry,
}: SetupProgressDialogProps) {
  const status = onboarding.status;
  const [visible, setVisible] = useState(false);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTriggerRect, setHelpTriggerRect] = useState<DOMRect | null>(null);
  const [pairingRetryNonce, setPairingRetryNonce] = useState(0);
  const skipRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  const isSubmitting = status.kind === "submitting";
  const submitStage = status.kind === "submitting" ? status.stage : null;
  const isComplete = status.kind === "complete";
  const errorMessage = status.kind === "error" ? status.message : null;
  const errorReason = status.kind === "error" ? status.reason : undefined;

  const isPairingStep = errorMessage === "device_pairing_required";
  const narrationText = isPairingStep ? NARRATION_PAIRING : NARRATION_DEFAULT;
  const pairingTimer = usePairingTimer(isPairingStep, pairingRetryNonce);

  // Re-trigger typing when narration changes (e.g. flipping into the
  // "your turn — approve OCCA" line once the gateway requests pairing).
  useEffect(() => {
    setDisplayedText("");
    setIsTyping(true);
    skipRef.current = false;
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) {
        setDisplayedText(narrationText);
        setIsTyping(false);
        clearInterval(id);
        return;
      }
      i++;
      setDisplayedText(narrationText.slice(0, i));
      if (i >= narrationText.length) {
        setIsTyping(false);
        clearInterval(id);
      }
    }, TYPING_SPEED);
    return () => clearInterval(id);
  }, [narrationText]);
  const errorHttpStatus =
    status.kind === "error" ? status.httpStatus : undefined;
  const errorResume = status.kind === "error" ? status.resume : undefined;
  const isError = !!errorMessage;

  const ceoName = onboarding.form.agentName || "Your CEO";
  const companyName = onboarding.form.companyName || "the company";

  const submittingLabel = (() => {
    switch (submitStage) {
      case "creating-company":
        return `Setting up ${companyName}…`;
      case "provisioning-agent":
        return `Wiring ${ceoName} into the OpenClaw gateway…`;
      case "gateway-restarting":
        return "Gateway is restarting to apply the new agent — hang tight, this can take a few seconds…";
      default:
        return `Setting up ${companyName}, bringing ${ceoName} online…`;
    }
  })();

  return (
    <div
      className="fixed inset-0 z-100 flex items-end justify-center pointer-events-none"
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
                {isComplete ? (
                  <CheckIcon />
                ) : isPairingStep ? (
                  <span className="w-3.5 h-3.5 rounded-full bg-amber-400/80 shrink-0" />
                ) : isError ? (
                  <span className="w-3.5 h-3.5 text-red-400 text-xs shrink-0">
                    ✕
                  </span>
                ) : (
                  <SpinnerIcon />
                )}
                <span
                  className="text-xs"
                  style={{
                    color: isComplete
                      ? "rgba(255,255,255,0.7)"
                      : isPairingStep
                        ? "rgba(253,224,71,0.9)"
                        : isError
                          ? "rgba(248,113,113,0.9)"
                          : submitStage === "gateway-restarting"
                            ? "rgba(253,224,71,0.9)"
                            : "rgba(255,255,255,0.55)",
                  }}
                >
                  {isPairingStep
                    ? "Waiting for you — approve OCCA"
                    : isError
                      ? prettifyError(errorMessage!).headline
                      : isComplete
                        ? `${companyName} is all set. ${ceoName} is standing by.`
                        : submittingLabel}
                </span>
              </div>

              {submitStage === "gateway-restarting" &&
                !isError &&
                !isComplete && (
                  <div className="mt-2 rounded-xl border border-amber-400/25 bg-amber-950/20 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full border-2 border-amber-300/30 border-t-amber-300/90 animate-spin shrink-0" />
                      <span className="text-xs text-amber-200/90 font-medium">
                        Waiting for OpenClaw to come back online…
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-amber-100/70 leading-relaxed">
                      Adding an agent to the gateway restarts OpenClaw. We're
                      holding the connection and will resume as soon as it's
                      healthy again — usually 5–15s.
                    </p>
                  </div>
                )}

              {isError && isPairingStep && (
                <Alert variant="warning" className="mt-2" icon={null}>
                  {pairingTimer.expired ? (
                    <>
                      <p className="text-xs font-semibold text-amber-300 leading-snug">
                        Pair request expired
                      </p>
                      <p className="mt-1.5 text-[11px] leading-relaxed">
                        OpenClaw cleared the pending request after 5 minutes.
                        Click below to send a fresh one.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-semibold text-amber-300 leading-snug">
                        Approve OCCA in OpenClaw
                      </p>
                      <p className="mt-1.5 text-[11px] leading-relaxed">
                        First time only. Pick a method below, then click "I've
                        approved" to continue.
                      </p>
                      <p
                        className="mt-1.5 inline-flex items-center gap-1 text-[10.5px] font-mono"
                        style={{
                          color:
                            pairingTimer.remaining < 60
                              ? "rgba(248,113,113,0.85)"
                              : "rgba(253,224,71,0.85)",
                        }}
                      >
                        <Clock className="size-3" />
                        Expires in {pairingTimer.formatted}
                      </p>
                    </>
                  )}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {pairingTimer.expired ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setPairingRetryNonce((n) => n + 1);
                          onRetry();
                        }}
                        disabled={isSubmitting}
                      >
                        Send new request
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={onRetry}
                        disabled={isSubmitting}
                      >
                        I've approved
                      </Button>
                    )}
                    <Button
                      variant="warning"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setHelpTriggerRect(
                          e.currentTarget.getBoundingClientRect(),
                        );
                        setHelpOpen(true);
                      }}
                    >
                      <Info className="size-3" />
                      How?
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        onboarding.backToEdit(errorResume ?? "review")
                      }
                      disabled={isSubmitting}
                    >
                      <Pencil className="size-3" />
                      Edit gateway / key
                    </Button>
                  </div>
                </Alert>
              )}

              {isError && !isPairingStep && (
                <Alert variant="error" className="mt-2" icon={null}>
                  <div className="flex items-start gap-2">
                    <p className="text-xs font-semibold text-red-300 flex-1 min-w-0 leading-snug">
                      {prettifyError(errorMessage!).headline}
                    </p>
                    <span className="font-mono text-[10px] text-red-400/70 bg-red-500/10 px-1.5 py-0.5 rounded shrink-0">
                      {errorHttpStatus ? `${errorHttpStatus} · ` : ""}
                      {errorMessage}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed">
                    {prettifyError(errorMessage!).hint}
                  </p>
                  {errorReason && (
                    <p className="mt-1.5 font-mono text-[10px] text-red-400/70 break-all leading-relaxed">
                      reason: {errorReason}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={onRetry}
                      disabled={isSubmitting}
                    >
                      <RefreshCw className="size-3" />
                      Retry
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        onboarding.backToEdit(errorResume ?? "review")
                      }
                      disabled={isSubmitting}
                    >
                      <Pencil className="size-3" />
                      {errorResume === "gateway-credentials"
                        ? "Edit gateway / key"
                        : "Back to review"}
                    </Button>
                  </div>
                </Alert>
              )}

              {isComplete && (
                <div className="flex items-center gap-2">
                  <CheckIcon />
                  <span className="text-xs text-emerald-400/80">
                    {ceoName} is awake. Let's go meet them.
                  </span>
                </div>
              )}
            </div>

            {isComplete && (
              <div className="mt-4 flex justify-center">
                <div className="h-1 w-16 rounded-full bg-emerald-400/50 animate-pulse" />
              </div>
            )}
          </Card>
        )}
      </div>

      {helpOpen && (
        <FloatingPanel
          title="Approve device pairing"
          subtitle="One-time setup"
          width={460}
          zIndex={150}
          triggerRect={helpTriggerRect}
          onClose={() => setHelpOpen(false)}
        >
          <DevicePairingHelp />
        </FloatingPanel>
      )}
    </div>
  );
}
