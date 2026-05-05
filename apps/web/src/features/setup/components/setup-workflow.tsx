"use client";

import { OnboardingFormDialog } from "./onboarding-form-dialog";
import { SetupProgressDialog } from "./setup-progress-dialog";
import { AnchorIdentityDialog } from "./anchor-identity-dialog";
import { CeoReadyDialog } from "./ceo-ready-dialog";
import { CeoIntroDialog } from "./ceo-intro-dialog";
import { KickoffDialog } from "./kickoff-dialog";
import { HiringWindow } from "./hiring-window";
import { KickoffSummaryDialog } from "./kickoff-summary-dialog";
import type { UseSetupWorkflowReturn } from "../hooks/use-setup-workflow";
import { CEO_ROLE } from "@occa/shared/role-catalog";

interface SetupWorkflowProps {
  /** The hook return is owned by the page (single instance), drilled down
   *  here so child dialogs share the same `onboarding` / `me` snapshots
   *  the page uses for OfficeScene / OsShell. */
  setup: UseSetupWorkflowReturn;
}

/**
 * Single switch covering every first-run phase from onboarding to live OS.
 * Renders nothing for `idle | walking | live` — those are handled by the
 * 3D scene (`walking`) or the OS chrome (`live`). All non-trivial phase
 * transitions happen inside `useSetupWorkflow`; this component is a pure
 * dispatcher.
 */
export function SetupWorkflow({ setup }: SetupWorkflowProps) {
  const {
    phase,
    onboarding,
    me,
    handleFormReady,
    handleRetryLaunch,
    handleStartWalk,
    handleIntroDone,
    handleKickoffStarted,
    handleHiringCompleted,
    handleHiringReset,
    handleEnterOffice,
  } = setup;

  if (phase === "idle" || phase === "walking" || phase === "live") {
    return null;
  }

  if (phase === "onboarding-form") {
    return (
      <OnboardingFormDialog onboarding={onboarding} onReady={handleFormReady} />
    );
  }

  if (phase === "provisioning-ceo") {
    return (
      <SetupProgressDialog
        onboarding={onboarding}
        onRetry={handleRetryLaunch}
      />
    );
  }

  if (phase === "anchoring-ceo") {
    return <AnchorIdentityDialog onboarding={onboarding} />;
  }

  // Cinematic dialogs need the CEO name; pull from the form during
  // onboarding (already validated) and fall back once the agent is
  // persisted. Same for company.
  const ceoName = onboarding.form.agentName || "Your CEO";
  const companyName = onboarding.form.companyName || "your company";

  if (phase === "ceo-ready") {
    return <CeoReadyDialog ceoName={ceoName} onStart={handleStartWalk} />;
  }

  if (phase === "ceo-intro") {
    return (
      <CeoIntroDialog
        ceoName={ceoName}
        companyName={companyName}
        onDone={handleIntroDone}
      />
    );
  }

  // Kickoff + hiring branches need a real CEO row. After the cinematic,
  // me.reload has fired and `me.company`+`agents` are populated. Defensive
  // null check prevents a render crash if the data races us — the next
  // me tick will resolve it.
  const company = me.company;
  const ceo = me.agents.find((a) => a.role === CEO_ROLE);
  if (!company || !ceo) return null;

  if (phase === "kickoff-form") {
    return (
      <KickoffDialog
        companyId={company.id}
        ceoName={ceo.name}
        onStarted={handleKickoffStarted}
      />
    );
  }

  if (phase === "hiring") {
    return (
      <HiringWindow
        companyId={company.id}
        onCompleted={handleHiringCompleted}
        onReset={handleHiringReset}
      />
    );
  }

  if (phase === "kickoff-complete") {
    return (
      <KickoffSummaryDialog
        agents={me.agents}
        onAgentReady={me.reload}
        onContinue={handleEnterOffice}
      />
    );
  }

  return null;
}
