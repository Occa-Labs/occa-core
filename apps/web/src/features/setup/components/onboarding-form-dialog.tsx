"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Info, Pencil } from "lucide-react";
import type { UseOnboardingResult } from "@/hooks/use-onboarding";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { SpeakerBadge } from "@/components/ui/speaker-badge";
import { usePairingTimer } from "@/hooks/use-pairing-timer";
import {
  DevicePairingHelp,
  deriveControlUiUrl,
} from "./device-pairing-help";

interface OnboardingFormDialogProps {
  onboarding: UseOnboardingResult;
  onReady: () => void;
}

type StepType = "dialog" | "input" | "probing" | "review";

// Stable keys for every wizard step. Keeps jump-to-step logic readable and
// survives any reordering of the steps array.
type StepKey =
  | "intro-hello"
  | "intro-purpose"
  | "company-input"
  | "company-ack"
  | "agent-input"
  | "gateway-input"
  | "api-key-input"
  | "pairing-info"
  | "probing"
  | "review";

interface InputField {
  key: "companyName" | "agentName" | "gatewayUrl" | "apiKey";
  placeholder: string;
  type?: "text" | "url" | "password";
  maxLength?: number;
}

interface Step {
  key: StepKey;
  text: string | ((d: FormSnapshot) => string);
  stepType: StepType;
  inputs?: InputField[];
}

interface FormSnapshot {
  companyName: string;
  agentName: string;
  gatewayUrl: string;
  apiKey: string;
}

const TYPING_SPEED = 32;
const STEP_DELAY = 500;

function buildSteps(): Step[] {
  return [
    { key: "intro-hello", text: "Hey. Glad you're here.", stepType: "dialog" },
    {
      key: "intro-purpose",
      text: "I'm Jia. You don't have a company yet — let's set one up.",
      stepType: "dialog",
    },
    {
      key: "company-input",
      text: "We'll start with the name. What is it?",
      stepType: "input",
      inputs: [
        { key: "companyName", placeholder: "Enter company name…", maxLength: 64 },
      ],
    },
    {
      key: "company-ack",
      text: (d) => `"${d.companyName}". Nice.`,
      stepType: "dialog",
    },
    {
      key: "agent-input",
      text: "Now the CEO or leader. Who's it going to be?",
      stepType: "input",
      inputs: [
        { key: "agentName", placeholder: "CEO or leader name…", maxLength: 64 },
      ],
    },
    {
      key: "gateway-input",
      text: (d) =>
        `Got it. I just need the gateway link to bring ${d.agentName} online.`,
      stepType: "input",
      inputs: [
        {
          key: "gatewayUrl",
          placeholder: "wss://your-gateway-host:port",
          type: "url",
          maxLength: 200,
        },
      ],
    },
    {
      key: "api-key-input",
      text: "Now the API key for this OpenClaw adapter. It authenticates the gateway handshake.",
      stepType: "input",
      inputs: [
        {
          key: "apiKey",
          placeholder: "Paste your API key…",
          type: "password",
          maxLength: 512,
        },
      ],
    },
    {
      key: "pairing-info",
      text: "One thing before we connect — OpenClaw asks you to approve OCCA the first time. I'll guide you through it. Takes a sec, only once.",
      stepType: "dialog",
    },
    {
      key: "probing",
      text: () => `Just checking everything works…`,
      stepType: "probing",
    },
    {
      key: "review",
      text: "Last look before we commit. Edit anything that's off, then launch.",
      stepType: "review",
    },
  ];
}

function prettifyProbeError(code: string | undefined): {
  headline: string;
  hint: string;
} {
  switch (code) {
    case "unreachable":
      return {
        headline: "Gateway unreachable.",
        hint: "TCP/WS handshake failed — verify host, port, and that the gateway process is running.",
      };
    case "unauthorized":
      return {
        headline: "Adapter auth rejected.",
        hint: "API key did not validate against the OpenClaw gateway. Regenerate and paste again.",
      };
    case "pairing_required":
      return {
        headline: "One-time device approval needed.",
        hint: "Auto-pairing was attempted but the gateway requires manual approval for the first device. Open the OpenClaw control UI, approve the pending pair request, then click Retry.",
      };
    case "invalid_response":
      return {
        headline: "Unexpected adapter response.",
        hint: "Probe succeeded but payload did not match the OpenClaw protocol schema.",
      };
    default:
      return {
        headline: "Probe failed.",
        hint: "No error code returned by the adapter.",
      };
  }
}

function maskApiKey(key: string): string {
  if (!key) return "—";
  if (key.length <= 6) return "••••";
  return `${"•".repeat(4)}${key.slice(-4)}`;
}

export function OnboardingFormDialog({
  onboarding,
  onReady,
}: OnboardingFormDialogProps) {
  // Stable across renders — otherwise `currentStep` would get a fresh object
  // reference every render and the typewriter effect (which lists it as a
  // dep) would restart each tick, clearing `displayedText` before the
  // interval could ever catch up. Symptom: flicker + dialog never types out.
  const steps = useMemo(() => buildSteps(), []);
  const stepIndexByKey = useMemo(() => {
    const m = new Map<StepKey, number>();
    steps.forEach((s, i) => m.set(s.key, i));
    return m;
  }, [steps]);

  const status = onboarding.status;
  const companyExists =
    status.kind === "needed" ? status.companyExists : false;
  const resumeTarget = status.kind === "needed" ? status.resume : undefined;

  // Compute the initial step index based on the current onboarding state:
  //  - resume=review          → jump straight to review
  //  - resume=gateway-creds   → jump to the gateway URL input
  //  - companyExists only     → skip the intro + company steps, start at agent
  //  - fresh                  → start at the beginning
  const initialStepIndex = useMemo(() => {
    if (resumeTarget === "review") return stepIndexByKey.get("review") ?? 0;
    if (resumeTarget === "gateway-credentials")
      return stepIndexByKey.get("gateway-input") ?? 0;
    if (companyExists) return stepIndexByKey.get("agent-input") ?? 0;
    return 0;
    // Only re-evaluate when the status kind/resume actually changes. Using
    // state ignores later updates to keep the dialog stable after mount —
    // which is what we want: the form dialog owns its own step index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [stepIndex, setStepIndex] = useState(initialStepIndex);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);
  const [visible, setVisible] = useState(false);
  const [inputValues, setInputValues] = useState<
    Partial<Record<InputField["key"], string>>
  >({});
  // When the user clicks Edit on a field from the review step, we remember
  // where to send them after they commit. Gateway/apiKey edits are routed
  // through probing (to re-validate); name edits go straight back to review.
  const [returnToKey, setReturnToKey] = useState<StepKey | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const skipRef = useRef(false);
  const probeTriggered = useRef(false);
  const readyFired = useRef(false);
  const [helpPanelKey, setHelpPanelKey] = useState<StepKey | null>(null);
  const [helpTriggerRect, setHelpTriggerRect] = useState<DOMRect | null>(null);
  const [pairingHelpOpen, setPairingHelpOpen] = useState(false);
  const [pairingHelpRect, setPairingHelpRect] = useState<DOMRect | null>(null);
  const [pairingRetryNonce, setPairingRetryNonce] = useState(0);

  useEffect(() => {
    setHelpPanelKey(null);
    setHelpTriggerRect(null);
    setPairingHelpOpen(false);
    setPairingHelpRect(null);
  }, [stepIndex]);

  const { form, probeResult, probing, probeAdapter, setCompanyName, setAgentName, setAdapterConfig } =
    onboarding;

  const snapshot: FormSnapshot = {
    companyName: form.companyName,
    agentName: form.agentName,
    gatewayUrl: form.adapterConfig.gatewayUrl,
    apiKey: form.adapterConfig.apiKey,
  };

  const currentStep = steps[stepIndex];
  const currentStepKey = currentStep?.key;
  const resolvedText = currentStep
    ? typeof currentStep.text === "function"
      ? currentStep.text(snapshot)
      : currentStep.text
    : "";

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(t);
  }, []);

  // Typewriter. Deps are intentionally limited to step + text: `currentStep`
  // identity would be unstable if `steps` weren't memoized above.
  useEffect(() => {
    if (!resolvedText) return;
    setDisplayedText("");
    setIsTyping(true);
    skipRef.current = false;
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) {
        setDisplayedText(resolvedText);
        setIsTyping(false);
        clearInterval(id);
        return;
      }
      i++;
      setDisplayedText(resolvedText.slice(0, i));
      if (i >= resolvedText.length) {
        setIsTyping(false);
        clearInterval(id);
      }
    }, TYPING_SPEED);
    return () => clearInterval(id);
  }, [stepIndex, resolvedText]);

  useEffect(() => {
    if (isTyping) return;
    if (currentStep?.stepType === "input") {
      const t = setTimeout(() => firstInputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [isTyping, currentStep?.stepType]);

  // Prefill input values from form state when (re)entering an input step.
  // Makes Edit-from-review behave intuitively: the existing value is shown
  // and can be adjusted rather than requiring the user to retype from
  // scratch.
  useEffect(() => {
    if (currentStep?.stepType !== "input") return;
    const next: Partial<Record<InputField["key"], string>> = {};
    for (const inp of currentStep.inputs ?? []) {
      if (inp.key === "companyName") next.companyName = form.companyName;
      else if (inp.key === "agentName") next.agentName = form.agentName;
      else if (inp.key === "gatewayUrl")
        next.gatewayUrl = form.adapterConfig.gatewayUrl;
      else if (inp.key === "apiKey") next.apiKey = form.adapterConfig.apiKey;
    }
    setInputValues(next);
    // form fields are intentionally excluded — only re-seed when the step
    // changes. Mid-step edits are owned by inputValues itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, currentStep?.stepType]);

  // Probing step: kick off the adapter probe once.
  useEffect(() => {
    if (currentStep?.stepType !== "probing") return;
    if (probeTriggered.current) return;
    probeTriggered.current = true;
    void probeAdapter();
  }, [currentStep?.stepType, probeAdapter]);

  // Probe success → either return to review (if we were editing) or advance
  // to review as part of the normal flow.
  useEffect(() => {
    if (currentStep?.stepType !== "probing") return;
    if (!probeResult?.ok) return;
    if (readyFired.current) return;
    readyFired.current = true;
    const t = setTimeout(() => {
      const reviewIdx = stepIndexByKey.get("review");
      if (reviewIdx !== undefined) setStepIndex(reviewIdx);
    }, STEP_DELAY);
    return () => clearTimeout(t);
  }, [currentStep?.stepType, probeResult, stepIndexByKey]);

  const advance = useCallback(() => {
    if (isTyping) {
      skipRef.current = true;
      return;
    }
    if (currentStep?.stepType !== "dialog") return;
    setStepIndex((i) => i + 1);
  }, [isTyping, currentStep?.stepType]);

  const commitInput = useCallback(() => {
    const inputs = currentStep?.inputs;
    if (!inputs) return;
    for (const f of inputs) {
      const v = (inputValues[f.key] ?? "").trim();
      if (!v) return;
    }
    let adapterChanged = false;
    for (const f of inputs) {
      const v = (inputValues[f.key] ?? "").trim();
      if (f.key === "companyName") setCompanyName(v);
      else if (f.key === "agentName") setAgentName(v);
      else if (f.key === "gatewayUrl") {
        setAdapterConfig({ gatewayUrl: v });
        adapterChanged = true;
      } else if (f.key === "apiKey") {
        setAdapterConfig({ apiKey: v });
        adapterChanged = true;
      }
    }
    setInputValues({});

    // Resolve where to go next based on the current intent:
    //  - Edit-from-review that touched adapter fields: route through probing
    //    so the new URL/key gets validated before landing back on review.
    //  - Edit-from-review that didn't touch adapter fields: jump right to
    //    review.
    //  - Fresh flow: just advance one step.
    setTimeout(() => {
      if (returnToKey) {
        if (adapterChanged) {
          const probingIdx = stepIndexByKey.get("probing");
          probeTriggered.current = false;
          readyFired.current = false;
          if (probingIdx !== undefined) setStepIndex(probingIdx);
        } else {
          const targetIdx = stepIndexByKey.get(returnToKey);
          if (targetIdx !== undefined) setStepIndex(targetIdx);
        }
        setReturnToKey(null);
      } else {
        setStepIndex((i) => i + 1);
      }
    }, STEP_DELAY);
  }, [
    currentStep,
    inputValues,
    returnToKey,
    setAdapterConfig,
    setAgentName,
    setCompanyName,
    stepIndexByKey,
  ]);

  const retryProbe = useCallback(() => {
    probeTriggered.current = false;
    readyFired.current = false;
    void probeAdapter();
  }, [probeAdapter]);

  const backToGatewayInputs = useCallback(() => {
    probeTriggered.current = false;
    readyFired.current = false;
    const idx = stepIndexByKey.get("gateway-input");
    if (idx !== undefined) setStepIndex(idx);
  }, [stepIndexByKey]);

  const jumpToEdit = useCallback(
    (targetKey: StepKey) => {
      const idx = stepIndexByKey.get(targetKey);
      if (idx === undefined) return;
      setReturnToKey("review");
      setStepIndex(idx);
    },
    [stepIndexByKey],
  );

  const confirmLaunch = useCallback(() => {
    onReady();
  }, [onReady]);

  const allInputsFilled = currentStep?.inputs?.every(
    (f) => (inputValues[f.key] ?? "").trim().length > 0,
  );

  const probeFailed = !!probeResult && !probeResult.ok;
  // In resume mode (browser refresh after a failed launch), the server
  // already has the agent + adapter config. Launch routes to reprovision —
  // no fresh probe is required for the button to be enabled.
  const isResume = !!onboarding.pendingAgentId;
  const canLaunch = !!probeResult?.ok || isResume;
  const pairingActive = probeResult?.error === "pairing_required";
  const pairingTimer = usePairingTimer(pairingActive, pairingRetryNonce);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (currentStep?.stepType === "input" && !isTyping) {
        e.stopPropagation();
        commitInput();
      } else if (currentStep?.stepType === "dialog") {
        advance();
      } else if (currentStep?.stepType === "review" && canLaunch) {
        e.stopPropagation();
        confirmLaunch();
      }
    },
    [advance, canLaunch, commitInput, confirmLaunch, currentStep?.stepType, isTyping],
  );

  if (!currentStep) return null;

  return (
    <div
      className="fixed inset-0 z-100 flex items-end justify-center"
      onClick={advance}
      onKeyDown={handleKeyDown}
      role="dialog"
      tabIndex={0}
    >
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-500"
        style={{
          opacity: visible ? 1 : 0,
          background:
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.25) 100%)",
        }}
      />
      <div
        className="relative w-full max-w-2xl mx-4 mb-8"
        onClick={(e) => {
          e.stopPropagation();
          advance();
        }}
      >
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

          {currentStep.stepType === "input" && !isTyping && (
            <div className="mt-4 flex flex-col gap-2">
              {(currentStepKey === "gateway-input" ||
                currentStepKey === "api-key-input") && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHelpTriggerRect(
                        e.currentTarget.getBoundingClientRect(),
                      );
                      setHelpPanelKey(currentStepKey);
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-[11px] text-white/65 hover:text-white hover:bg-white/15 hover:border-white/25 transition-all"
                    aria-label={
                      currentStepKey === "gateway-input"
                        ? "Gateway URL setup help"
                        : "API token help"
                    }
                  >
                    <Info className="size-3" />
                    {currentStepKey === "gateway-input"
                      ? "Where to find URL?"
                      : "Where to find token?"}
                  </button>
                </div>
              )}
              {currentStep.inputs?.map((inp, i) => (
                <input
                  key={inp.key}
                  ref={i === 0 ? firstInputRef : undefined}
                  value={inputValues[inp.key] ?? ""}
                  onChange={(e) =>
                    setInputValues((prev) => ({
                      ...prev,
                      [inp.key]: e.target.value,
                    }))
                  }
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      commitInput();
                    }
                  }}
                  placeholder={inp.placeholder}
                  type={inp.type ?? "text"}
                  maxLength={inp.maxLength}
                  className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/20 transition-colors"
                />
              ))}
              <div className="flex justify-end">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    commitInput();
                  }}
                  disabled={!allInputsFilled}
                  className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  {returnToKey ? "Save" : "Confirm"}
                </button>
              </div>
            </div>
          )}

          {currentStep.stepType === "probing" && !isTyping && (
            <div className="mt-4">
              {probeFailed ? (
                probeResult?.error === "pairing_required" ? (
                  <div className="flex flex-col gap-2">
                    {pairingTimer.expired ? (
                      <Alert variant="warning" icon={null}>
                        <p className="text-xs font-semibold text-amber-300 leading-snug">
                          Pair request expired
                        </p>
                        <p className="mt-1.5 text-[11px] leading-relaxed">
                          OpenClaw cleared the pending request after 5 minutes.
                          Click below to send a fresh one.
                        </p>
                      </Alert>
                    ) : (
                      <Alert variant="warning" icon={null}>
                        <p className="text-xs font-semibold text-amber-300 leading-snug">
                          Approve OCCA in OpenClaw
                        </p>
                        <p className="mt-1.5 text-[11px] leading-relaxed">
                          First time only. Pick a method below, then click
                          "I've approved" to continue.
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
                      </Alert>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      {pairingTimer.expired ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPairingRetryNonce((n) => n + 1);
                            retryProbe();
                          }}
                          disabled={probing}
                        >
                          Send new request
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            retryProbe();
                          }}
                          disabled={probing}
                        >
                          I've approved
                        </Button>
                      )}
                      <Button
                        variant="warning"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPairingHelpRect(
                            e.currentTarget.getBoundingClientRect(),
                          );
                          setPairingHelpOpen(true);
                        }}
                      >
                        <Info className="size-3" />
                        How?
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          backToGatewayInputs();
                        }}
                      >
                        Edit gateway / key
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Alert variant="error" icon={null}>
                      <div className="flex items-start gap-2">
                        <p className="text-xs font-semibold text-red-300 flex-1 min-w-0 leading-snug">
                          {prettifyProbeError(probeResult?.error).headline}
                        </p>
                        <span className="font-mono text-[10px] text-red-400/70 bg-red-500/10 px-1.5 py-0.5 rounded shrink-0">
                          {probeResult?.error ?? "unknown"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed">
                        {prettifyProbeError(probeResult?.error).hint}
                      </p>
                    </Alert>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          retryProbe();
                        }}
                        disabled={probing}
                      >
                        Retry
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          backToGatewayInputs();
                        }}
                      >
                        Change URL / key
                      </Button>
                    </div>
                  </div>
                )
              ) : probeResult?.ok ? (
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-xs text-emerald-300">
                    Gateway online · {probeResult.latencyMs}ms
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white/80 animate-spin" />
                  <span className="text-xs text-white/40">
                    {probing ? "Connecting…" : "Waiting for connection…"}
                  </span>
                </div>
              )}
            </div>
          )}

          {currentStep.stepType === "review" && !isTyping && (
            <div
              className="mt-4 flex flex-col gap-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="rounded-xl border border-white/10 bg-white/3 divide-y divide-white/5">
                <ReviewRow
                  label="Company"
                  value={form.companyName || "—"}
                  onEdit={
                    companyExists
                      ? undefined
                      : () => jumpToEdit("company-input")
                  }
                  lockedHint={
                    companyExists
                      ? "Already created — rename later in settings."
                      : undefined
                  }
                />
                <ReviewRow
                  label="Agent"
                  value={`${form.agentName || "—"}${form.agentRole ? ` (${form.agentRole})` : ""}`}
                  onEdit={() => jumpToEdit("agent-input")}
                />
                <ReviewRow
                  label="Gateway URL"
                  value={form.adapterConfig.gatewayUrl || "—"}
                  mono
                  onEdit={() => jumpToEdit("gateway-input")}
                />
                <ReviewRow
                  label="API Key"
                  value={maskApiKey(form.adapterConfig.apiKey)}
                  mono
                  onEdit={() => jumpToEdit("api-key-input")}
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {isResume && !probeResult?.ok ? (
                    <>
                      <div className="h-2 w-2 rounded-full bg-blue-400 shrink-0" />
                      <span className="text-[11px] text-blue-300/90 truncate">
                        Resuming previous setup — credentials stored
                      </span>
                    </>
                  ) : canLaunch ? (
                    <>
                      <div className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
                      <span className="text-[11px] text-emerald-300/90 truncate">
                        Gateway verified · {probeResult?.latencyMs}ms
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
                      <span className="text-[11px] text-amber-300/90 truncate">
                        Re-verify gateway before launch
                      </span>
                    </>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmLaunch();
                  }}
                  disabled={!canLaunch}
                  className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  Launch
                </button>
              </div>
            </div>
          )}

          {!isTyping && currentStep.stepType === "dialog" && (
            <div className="mt-3 flex justify-end">
              <span className="rounded-full border border-white/20 bg-white/8 px-3 py-1 text-[11px] text-white/70 hover:bg-white/15 hover:text-white transition-colors cursor-pointer select-none">
                Continue ›
              </span>
            </div>
          )}

          <div className="mt-4 flex items-center justify-center gap-1.5">
            {steps.map((_, i) => (
              <div
                key={i}
                className="h-1 rounded-full transition-all duration-300"
                style={{
                  width: i === stepIndex ? 16 : 6,
                  backgroundColor:
                    i === stepIndex
                      ? "rgba(255,255,255,0.6)"
                      : i < stepIndex
                        ? "rgba(255,255,255,0.3)"
                        : "rgba(255,255,255,0.1)",
                }}
              />
            ))}
          </div>

          {currentStepKey === "review" && (
            <p className="mt-2 text-center text-[10px] text-white/35">
              Double-check before launch — once Jia starts provisioning, the
              gateway will restart to add the new agent.
            </p>
          )}
        </Card>
        )}
      </div>

      {helpPanelKey && (
        <FloatingPanel
          title={
            helpPanelKey === "gateway-input"
              ? "Gateway URL setup"
              : "Find your API token"
          }
          subtitle="OpenClaw gateway"
          width={440}
          zIndex={150}
          triggerRect={helpTriggerRect}
          onClose={() => setHelpPanelKey(null)}
        >
          <ConnectHelpContent stepKey={helpPanelKey} />
        </FloatingPanel>
      )}

      {pairingHelpOpen && (
        <FloatingPanel
          title="Approve device pairing"
          subtitle="One-time setup"
          width={460}
          zIndex={150}
          triggerRect={pairingHelpRect}
          onClose={() => setPairingHelpOpen(false)}
        >
          <DevicePairingHelp
            controlUiUrl={deriveControlUiUrl(form.adapterConfig.gatewayUrl)}
          />
        </FloatingPanel>
      )}
    </div>
  );
}

function ConnectHelpContent({ stepKey }: { stepKey: StepKey }) {
  if (stepKey === "gateway-input") {
    return (
      <div className="px-4 py-4 space-y-4 text-[12px] text-white/75 leading-relaxed">
        <div>
          <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
            URL format
          </p>
          <code className="block bg-white/5 rounded-md px-2.5 py-1.5 font-mono text-[11px] text-white/85">
            wss://&lt;host&gt;[:&lt;port&gt;]
          </code>
        </div>

        <div>
          <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
            Common setups
          </p>
          <ul className="space-y-1 font-mono text-[11px]">
            <li className="flex gap-2">
              <span className="text-white/40 shrink-0 w-20">Localhost</span>
              <span className="text-white/85 break-all">
                wss://localhost:18789
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-white/40 shrink-0 w-20">Public TLS</span>
              <span className="text-white/85 break-all">
                wss://gateway.example.com
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-white/40 shrink-0 w-20">Tailscale</span>
              <span className="text-white/85 break-all">
                wss://&lt;host&gt;.ts.net:18789
              </span>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-white/45 text-[10.5px] uppercase tracking-wide mb-1.5">
            Non-localhost setup
          </p>
          <p className="text-white/65 mb-1.5">
            Add to{" "}
            <code className="font-mono text-white/85">
              ~/.openclaw/openclaw.json
            </code>
            :
          </p>
          <pre className="bg-white/5 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white/80 overflow-x-auto leading-snug">{`"gateway": {
  "trustedProxies": ["127.0.0.1"],
  "controlUi": {
    "allowedOrigins": [
      "http://localhost:3001"
    ]
  }
}`}</pre>
          <p className="text-white/55 mt-2 text-[11px]">
            Then restart:{" "}
            <code className="font-mono text-white/75">
              systemctl --user restart openclaw-gateway
            </code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 space-y-3 text-[12px] text-white/75 leading-relaxed">
      <p>
        Open{" "}
        <code className="font-mono text-white/85">
          ~/.openclaw/openclaw.json
        </code>{" "}
        on your gateway host:
      </p>
      <pre className="bg-white/5 rounded-md px-2.5 py-2 font-mono text-[10.5px] text-white/80 overflow-x-auto leading-snug">{`"gateway": {
  "auth": {
    "token": "<your API key>"
  }
}`}</pre>
      <p className="text-white/55 text-[11px]">
        If the field is missing, run{" "}
        <code className="font-mono text-white/75">openclaw onboard</code> on the
        gateway host to generate one.
      </p>
    </div>
  );
}

interface ReviewRowProps {
  label: string;
  value: string;
  mono?: boolean;
  onEdit?: () => void;
  lockedHint?: string;
}

function ReviewRow({ label, value, mono, onEdit, lockedHint }: ReviewRowProps) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-white/40 w-24 shrink-0">
        {label}
      </span>
      <span
        className={`flex-1 min-w-0 truncate text-xs ${mono ? "font-mono text-white/75" : "text-white/85"}`}
        title={value}
      >
        {value}
      </span>
      {onEdit ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 hover:text-white transition-colors"
        >
          <Pencil className="size-3" />
          Edit
        </button>
      ) : (
        <span className="text-[10px] text-white/35 truncate max-w-40">
          {lockedHint}
        </span>
      )}
    </div>
  );
}
