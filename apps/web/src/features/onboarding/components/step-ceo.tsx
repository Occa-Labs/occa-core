"use client";

// Onboarding step 3 — capture the CEO's name and submit the atomic
// deploy. The server creates the company row + CEO row + provisions
// the agent on the gateway in one go (mirrors archived launch flow).
// Sub-stages from the SSE stream are surfaced inline so the user sees
// real progress instead of a silent 5-30s spinner.

import { AlertTriangle, Crown, Loader2, Sparkles } from "lucide-react";
import type {
  AdapterType,
  HermesAdapterConfig,
  OpenclawAdapterConfig,
} from "@occa/shared/types";
import { useDeployCeo, type DeployStage } from "../api/use-deploy-ceo";

interface StepCeoProps {
  companyName: string;
  ceoName: string;
  onCeoNameChange: (next: string) => void;
  adapterType: AdapterType;
  adapterConfig: OpenclawAdapterConfig | HermesAdapterConfig;
  /** When set, retry an existing failed provision via /reprovision
   *  instead of POSTing a fresh deploy. Surfaced by parent resume
   *  detection and updated in-place if a fresh launch fails after the
   *  DB row was already committed. Phase 0 reprovision is openclaw-only;
   *  hermes always re-creates. */
  pendingAgentId: string | null;
  onPendingAgentIdChange: (next: string | null) => void;
  onBack: () => void;
}

export function StepCeo({
  companyName,
  ceoName,
  onCeoNameChange,
  adapterType,
  adapterConfig,
  pendingAgentId,
  onPendingAgentIdChange,
  onBack,
}: StepCeoProps) {
  const deploy = useDeployCeo();
  const trimmed = ceoName.trim();
  const busy = isBusy(deploy.stage);
  const canSubmit = trimmed.length > 0 && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    await deploy.run({
      ceoName: trimmed,
      companyName,
      adapterType,
      adapterConfig,
      pendingAgentId,
    });
    // After the call, the hook may have updated pendingAgentId — sync
    // it to parent so a reload mid-flow lands back on this step with
    // the right reprovision target.
    if (deploy.pendingAgentId !== pendingAgentId) {
      onPendingAgentIdChange(deploy.pendingAgentId);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <div className="flex items-start gap-2.5">
        <Crown className="size-4 shrink-0 text-amber-300/80 mt-0.5" />
        <div>
          <h2 className="text-[13px] font-semibold text-white/90">
            {pendingAgentId ? "Resume CEO deploy" : "Deploy your CEO"}
          </h2>
          <p className="mt-1 text-[11px] text-white/45 leading-relaxed">
            The CEO is your single point of contact. You talk to them;
            they route work to specialists as you add them later. Submit
            now to create the company &amp; CEO together — additional
            agents can be deployed any time from the Agents window.
          </p>
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-white/40">
          CEO name
        </span>
        <input
          type="text"
          autoFocus={!pendingAgentId}
          value={ceoName}
          onChange={(e) => onCeoNameChange(e.target.value)}
          placeholder="Your CEO's name"
          maxLength={64}
          disabled={busy}
          className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none disabled:opacity-60"
        />
      </label>

      <ProgressBlock stage={deploy.stage} />

      {deploy.stage === "error" && deploy.error && (
        <div className="flex items-start gap-2 rounded-md border border-red-400/20 bg-red-500/8 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-red-300/80 mt-0.5" />
          <div className="flex-1 text-[11px] leading-relaxed text-red-200/80">
            <div className="font-medium">{prettifyError(deploy.error.message)}</div>
            {deploy.error.reason && (
              <div className="mt-0.5 text-red-200/55">{deploy.error.reason}</div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] text-white/55 transition-colors hover:bg-white/6 hover:text-white/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex cursor-pointer items-center gap-1.5 rounded-md bg-sky-500/20 px-3 py-1.5 text-[12px] font-medium text-sky-100 transition-colors hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {deploy.stage === "error"
            ? "Retry"
            : pendingAgentId
              ? "Resume deploy"
              : "Deploy & finish"}
        </button>
      </div>
    </form>
  );
}

function isBusy(stage: DeployStage): boolean {
  return (
    stage === "creating-company" ||
    stage === "provisioning-agent" ||
    stage === "gateway-restarting"
  );
}

function ProgressBlock({ stage }: { stage: DeployStage }) {
  if (!isBusy(stage)) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-white/8 bg-white/4 px-3 py-2 text-[11px] text-white/70">
      <Loader2 className="size-3.5 animate-spin text-sky-300/80" />
      <span>{labelForStage(stage)}</span>
    </div>
  );
}

function labelForStage(stage: DeployStage): string {
  switch (stage) {
    case "creating-company":
      return "Creating company & CEO record…";
    case "provisioning-agent":
      return "Provisioning agent on gateway…";
    case "gateway-restarting":
      return "Gateway is restarting to apply config (this can take ~20s)…";
    case "done":
      return "Done.";
    default:
      return "";
  }
}

// Surface server-side error codes in human terms. Anything we don't
// recognise falls through to the raw code so support can still triage.
function prettifyError(code: string): string {
  switch (code) {
    case "gateway_unauthorized":
      return "The gateway rejected the bearer token.";
    case "adapter_probe_failed":
      return "Could not reach the gateway — check the URL and try again.";
    case "gateway_unreachable":
      return "Gateway is unreachable.";
    case "device_pairing_required":
      return "OpenClaw needs to approve this device pairing.";
    case "gateway_provision_failed":
      return "Gateway failed to provision the agent.";
    case "gateway_restart_timeout":
      return "Gateway didn't come back after the config restart.";
    case "openclaw_agent_id_conflict":
      return "An OpenClaw agent with this id already exists.";
    case "company_already_exists":
      return "You already have a company — reload to continue.";
    case "conflict":
      return "Conflicting state on the server.";
    default:
      return `Deploy failed (${code}).`;
  }
}
