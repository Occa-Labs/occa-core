"use client";

// Top-level onboarding window — three-step wizard that mirrors the
// archived setup flow's commit shape: nothing is persisted on the
// server until the final step, which atomically creates the company +
// CEO row and provisions the agent on the gateway. Form state lives
// here so step components stay dumb and a Back nav doesn't lose what
// the user already typed.
//
// Resume: on mount we read `/api/me` and skip past whatever the server
// already has. A reload mid-flow lands the user back on the right
// step — partial provision → step 3 with `pendingAgentId` so the retry
// hits /reprovision instead of duplicating the OpenClaw agent.

import { useMemo, useState } from "react";
import { AppWindow } from "@/components/ui/app-window";
import type { AgentDTO, CompanyDTO } from "@occa/shared/types";
import { getTier } from "@occa/shared/role-catalog";
import { StepperHeader } from "./stepper-header";
import { StepCompany } from "./step-company";
import { StepGateway } from "./step-gateway";
import { StepCeo } from "./step-ceo";

interface OnboardingWindowProps {
  /** Snapshot of /api/me used to compute the resume target. The window
   *  reads it once at mount; live updates after step 3 trigger the
   *  parent's gate to unmount us. */
  me: { company: CompanyDTO | null; agents: AgentDTO[] };
  /** Dismiss without finishing. Stays dismissed for the session via
   *  parent-level local state. */
  onDismiss: () => void;
}

const STEPS = [
  { label: "Company" },
  { label: "Gateway" },
  { label: "CEO" },
] as const;

const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 480;

export function OnboardingWindow({ me, onDismiss }: OnboardingWindowProps) {
  // Resume detection runs once on mount — re-running on every me-refresh
  // would yank the user off their current step mid-edit.
  const resume = useMemo(() => deriveResume(me), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [stepIndex, setStepIndex] = useState(resume.initialStep);
  const [completed, setCompleted] = useState<ReadonlySet<number>>(
    resume.completed,
  );

  const [companyName, setCompanyName] = useState(resume.companyName);
  const [gatewayUrl, setGatewayUrl] = useState("wss://gateway.occa.team");
  const [apiKey, setApiKey] = useState("");
  const [ceoName, setCeoName] = useState(resume.ceoName);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(
    resume.pendingAgentId,
  );

  const markCompleted = (i: number) =>
    setCompleted((prev) => {
      if (prev.has(i)) return prev;
      const next = new Set(prev);
      next.add(i);
      return next;
    });

  const handleCompanyContinue = () => {
    markCompleted(0);
    setStepIndex(1);
  };

  const handleGatewayContinue = () => {
    markCompleted(1);
    setStepIndex(2);
  };

  const center = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    return {
      x: Math.max(12, Math.round((window.innerWidth - WINDOW_WIDTH) / 2)),
      y: Math.max(56, Math.round((window.innerHeight - WINDOW_HEIGHT) / 2)),
    };
  }, []);

  return (
    <AppWindow
      title="Set up your OCCA"
      subtitle={`Step ${stepIndex + 1} of ${STEPS.length}`}
      onClose={onDismiss}
      defaultPosition={center}
      defaultSize={{ w: WINDOW_WIDTH, h: WINDOW_HEIGHT }}
      minWidth={420}
      minHeight={380}
    >
      <div className="flex h-full flex-col gap-2 px-5 py-4">
        <StepperHeader
          steps={STEPS as unknown as { label: string }[]}
          current={stepIndex}
          completed={completed}
        />
        <div className="flex-1 overflow-y-auto pt-2">
          {stepIndex === 0 && (
            <StepCompany
              value={companyName}
              onChange={setCompanyName}
              onContinue={handleCompanyContinue}
            />
          )}
          {stepIndex === 1 && (
            <StepGateway
              gatewayUrl={gatewayUrl}
              apiKey={apiKey}
              onGatewayUrlChange={setGatewayUrl}
              onApiKeyChange={setApiKey}
              onContinue={handleGatewayContinue}
              onBack={() => setStepIndex(0)}
            />
          )}
          {stepIndex === 2 && (
            <StepCeo
              companyName={companyName}
              ceoName={ceoName}
              onCeoNameChange={setCeoName}
              gatewayUrl={gatewayUrl}
              apiKey={apiKey}
              pendingAgentId={pendingAgentId}
              onPendingAgentIdChange={setPendingAgentId}
              onBack={() => setStepIndex(1)}
            />
          )}
        </div>
      </div>
    </AppWindow>
  );
}

// ── Resume derivation ───────────────────────────────────────────────────
// Cases we surface:
//   1. No company yet → fresh run, step 0.
//   2. Company + CEO already provisioned (externalAgentId set) → window
//      shouldn't be visible at all; parent gate handles it. Defensive
//      fallthrough lands on step 0 with the existing name pre-filled so
//      the user can at least see something coherent.
//   3. Company + CEO row but externalAgentId === null → previous launch
//      committed the DB row but provisioning died on the gateway. Skip
//      directly to step 1 (Gateway) with the agent id stashed so the
//      final-step submit calls /reprovision instead of POSTing a fresh
//      deploy (which would orphan a second gateway agent).
//   4. Company but no CEO at all → legacy partial state. Skip to step 1.

interface ResumeState {
  initialStep: number;
  completed: ReadonlySet<number>;
  companyName: string;
  ceoName: string;
  pendingAgentId: string | null;
}

function deriveResume(me: {
  company: CompanyDTO | null;
  agents: AgentDTO[];
}): ResumeState {
  if (!me.company) {
    return {
      initialStep: 0,
      completed: new Set<number>(),
      companyName: "",
      ceoName: "",
      pendingAgentId: null,
    };
  }
  const ceo = me.agents.find((a) => getTier(a.role) === "ceo") ?? null;
  // Company exists; step 0 is settled regardless of CEO state.
  const completed = new Set<number>([0]);
  if (ceo && ceo.externalAgentId === null) {
    return {
      initialStep: 1,
      completed,
      companyName: me.company.name,
      ceoName: ceo.name,
      pendingAgentId: ceo.id,
    };
  }
  return {
    initialStep: 1,
    completed,
    companyName: me.company.name,
    ceoName: ceo?.name ?? "",
    pendingAgentId: null,
  };
}
