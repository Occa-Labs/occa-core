"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentRole,
  type CompanyDTO,
  type OpenclawAdapterConfig,
  type ProbeResponse,
} from "@occa/shared/types";
import { adaptersApi, agentsApi, ApiError, meApi } from "@/lib/api";
import { CEO_ROLE } from "@occa/shared/role-catalog";

// Sub-stage of the submitting phase. Surfaced so the setup dialog can show
// the user what's happening — especially "gateway-restarting", which can take
// 20–30s while OpenClaw applies config changes.
export type SubmitStage =
  | "creating-company"
  | "provisioning-agent"
  | "gateway-restarting";

// Where the setup-error UI should send the user when they click "Back to
// edit". Lets us return to the right step instead of always the top.
export type ResumeTarget = "review" | "gateway-credentials";

export type OnboardingStatus =
  | { kind: "loading" }
  | { kind: "not_needed"; company: CompanyDTO }
  | {
      kind: "needed";
      // True when the server already has a company row for this user but no
      // agent yet (partial onboarding — previous attempt got past step 1 and
      // died on agent provisioning). Drives the form dialog to skip the
      // company-name step and jump straight to agent setup.
      companyExists: boolean;
      // If set, the form dialog should mount directly at this step key
      // instead of starting at the intro. Used by backToReview/backToEdit.
      resume?: ResumeTarget;
    }
  | { kind: "submitting"; stage: SubmitStage }
  | { kind: "complete"; company: CompanyDTO }
  | {
      kind: "error";
      message: string;
      reason?: string;
      httpStatus?: number;
      // Where the "Back to edit" button in the progress dialog should send
      // the user. Error codes related to the gateway/adapter config get
      // "gateway-credentials"; everything else lands on the review step so
      // they can inspect all inputs.
      resume: ResumeTarget;
    };

export interface OnboardingForm {
  companyName: string;
  agentName: string;
  agentRole: AgentRole;
  adapterConfig: OpenclawAdapterConfig;
}

const DEFAULT_FORM: OnboardingForm = {
  companyName: "",
  agentName: "",
  agentRole: CEO_ROLE,
  adapterConfig: { gatewayUrl: "", apiKey: "" },
};

export interface UseOnboardingResult {
  status: OnboardingStatus;
  form: OnboardingForm;
  probeResult: ProbeResponse | null;
  probing: boolean;
  /**
   * Set when a previous launch attempt failed AFTER the agent row was
   * committed. The next launch reuses this id (idempotent reprovision)
   * instead of creating a duplicate agent. UI uses this as the "resume"
   * signal to keep Launch enabled even when there's no fresh probe result
   * (e.g. after a browser refresh where in-memory probe state is gone but
   * the server still has a half-provisioned agent).
   */
  pendingAgentId: string | null;
  setCompanyName: (v: string) => void;
  setAgentName: (v: string) => void;
  setAgentRole: (v: AgentRole) => void;
  setAdapterConfig: (v: Partial<OpenclawAdapterConfig>) => void;
  probeAdapter: () => Promise<void>;
  launch: () => Promise<void>;
  /** Transition from error back into the form at the given step. */
  backToEdit: (target: ResumeTarget) => void;
  /** Enabled only when authenticated is true. Parent drives this. */
  refresh: () => Promise<void>;
}

// Switch to the "gateway-restarting" hint after this long stuck in
// "provisioning-agent". Chosen to match the quiet window on a typical
// OpenClaw restart (~3–5s) so the hint appears before users lose patience
// but doesn't flash for fast no-restart commits.
const RESTART_HINT_DELAY_MS = 4000;

// Given a server error code, decide which step the user should be sent back
// to when they click "Back to edit". Credential errors send them to the
// gateway/apiKey inputs; everything else lands on the review step.
function resumeForError(code: string): ResumeTarget {
  switch (code) {
    case "adapter_probe_failed":
    case "gateway_unreachable":
    case "gateway_unauthorized":
    case "device_pairing_required":
    case "gateway_provision_failed":
    case "gateway_restart_timeout":
    case "openclaw_agent_id_conflict":
      return "gateway-credentials";
    default:
      return "review";
  }
}

export function useOnboarding(authenticated: boolean): UseOnboardingResult {
  const [status, setStatus] = useState<OnboardingStatus>({ kind: "loading" });
  const [form, setForm] = useState<OnboardingForm>(DEFAULT_FORM);
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);
  const [probing, setProbing] = useState(false);
  // Set when a previous launch attempt failed AFTER the agent was created in
  // DB. Subsequent retries reuse this id via the reprovision endpoint instead
  // of creating a new agent (which would pile up on both DB and gateway —
  // every restart attempt produced a fresh row in earlier versions).
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const lastAuthRef = useRef<boolean>(false);

  const refresh = useCallback(async () => {
    if (!authenticated) {
      setStatus({ kind: "loading" });
      return;
    }
    try {
      const res = await meApi.get();

      // Detect a half-onboarded agent: row exists but provision didn't
      // complete (no externalAgentId yet). Survives browser refresh —
      // before this check, a refresh dropped `pendingAgentId` and the next
      // Launch would create a duplicate agent on the gateway.
      //
      // SCOPE: only the CEO is "the onboarding agent". Kickoff hires (any
      // role !== "ceo") that fail provisioning are a separate concern and
      // must NOT push the user back into the onboarding flow — that bug
      // hid the OsShell + HiringWindow whenever a kickoff had any failed
      // hire row in the DB.
      const incompleteCeo = res.agents.find(
        (a) => a.role === CEO_ROLE && a.externalAgentId == null,
      );

      if (incompleteCeo && res.company) {
        setPendingAgentId(incompleteCeo.id);
        setForm((f) => ({
          ...f,
          companyName: res.company!.name,
          agentName: incompleteCeo.name,
          agentRole: incompleteCeo.role as AgentRole,
        }));
        setStatus({
          kind: "needed",
          companyExists: true,
          resume: "review",
        });
        return;
      }

      // No incomplete agent — clear any stale pending id and treat as
      // either fully onboarded or fresh.
      setPendingAgentId(null);

      if (res.company && res.agents.length > 0) {
        setStatus({ kind: "not_needed", company: res.company });
        return;
      }
      if (res.company) {
        // Partial onboarding: company exists but no agent. Seed the
        // companyName so review/edit screens show the right value, and flip
        // into the resumable needed state.
        setForm((f) => ({ ...f, companyName: res.company!.name }));
        setStatus({ kind: "needed", companyExists: true });
        return;
      }
      setStatus({ kind: "needed", companyExists: false });
    } catch (err) {
      const message =
        err instanceof ApiError ? `api_${err.status}` : "network_error";
      setStatus({
        kind: "error",
        message,
        resume: "review",
      });
    }
  }, [authenticated]);

  useEffect(() => {
    // Only fetch when auth flips to true; avoid refetch on unrelated renders.
    if (authenticated && !lastAuthRef.current) {
      lastAuthRef.current = true;
      void refresh();
    }
    if (!authenticated && lastAuthRef.current) {
      lastAuthRef.current = false;
      setStatus({ kind: "loading" });
      setForm(DEFAULT_FORM);
      setProbeResult(null);
    }
  }, [authenticated, refresh]);

  const setCompanyName = useCallback((v: string) => {
    setForm((f) => ({ ...f, companyName: v }));
  }, []);
  const setAgentName = useCallback((v: string) => {
    setForm((f) => ({ ...f, agentName: v }));
  }, []);
  const setAgentRole = useCallback((v: AgentRole) => {
    setForm((f) => ({ ...f, agentRole: v }));
  }, []);
  const setAdapterConfig = useCallback((v: Partial<OpenclawAdapterConfig>) => {
    setForm((f) => ({ ...f, adapterConfig: { ...f.adapterConfig, ...v } }));
    // Any edit invalidates the last probe result.
    setProbeResult(null);
  }, []);

  const probeAdapter = useCallback(async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const res = await adaptersApi.probeOpenclaw(form.adapterConfig);
      setProbeResult(res);
    } catch (err) {
      const errCode: ProbeResponse["error"] =
        err instanceof ApiError && err.status === 400
          ? "invalid_response"
          : "unreachable";
      setProbeResult({ ok: false, latencyMs: 0, error: errCode });
    } finally {
      setProbing(false);
    }
  }, [form.adapterConfig]);

  const backToEdit = useCallback((target: ResumeTarget) => {
    // Pull the user back into the form from an error state. We preserve the
    // companyExists flag by inspecting current status (it should have been
    // known when launch failed). Default to true — reaching error means we
    // at least tried to create the company.
    //
    // If the user is heading back to edit gateway credentials, drop the
    // pending agent id — the existing DB row was provisioned with the old
    // credentials, so the next launch needs to create a fresh agent that
    // picks up the new gatewayUrl/apiKey from the form.
    if (target === "gateway-credentials") {
      setPendingAgentId(null);
    }
    setStatus((s) => {
      if (s.kind !== "error") return s;
      return {
        kind: "needed",
        companyExists: true,
        resume: target,
      };
    });
  }, []);

  const launch = useCallback(async () => {
    // Streaming SSE call to either:
    //  - POST /api/agents (initial onboarding — creates company + agent row,
    //    then provisions on the gateway), or
    //  - POST /api/agents/:id/reprovision (idempotent retry — reuses the
    //    existing agent row + externalAgentId so the gateway doesn't
    //    duplicate. If the gateway already has the same agent registered,
    //    no restart is triggered and verify completes in <1s).
    setStatus({ kind: "submitting", stage: "creating-company" });
    let restartHintTimer: ReturnType<typeof setTimeout> | null = null;

    const provisioningHintTimer = setTimeout(() => {
      setStatus((s) =>
        s.kind === "submitting" && s.stage === "creating-company"
          ? { kind: "submitting", stage: "provisioning-agent" }
          : s,
      );
    }, 800);
    restartHintTimer = setTimeout(() => {
      setStatus((s) =>
        s.kind === "submitting" &&
        (s.stage === "provisioning-agent" || s.stage === "creating-company")
          ? { kind: "submitting", stage: "gateway-restarting" }
          : s,
      );
    }, RESTART_HINT_DELAY_MS);

    // Drive `submitting.stage` from real server step events instead of
    // (only) the time-based hints above. Hints still fire when the SSE is
    // briefly silent (e.g. across the gateway restart), but explicit
    // `gateway_restart` step events flip immediately.
    const onStep = (evt: { status: "running" | "done"; step: string }) => {
      if (evt.status !== "running") return;
      if (evt.step === "creating_record") {
        setStatus((s) =>
          s.kind === "submitting"
            ? { kind: "submitting", stage: "creating-company" }
            : s,
        );
      } else if (evt.step === "provisioning") {
        setStatus((s) =>
          s.kind === "submitting"
            ? { kind: "submitting", stage: "provisioning-agent" }
            : s,
        );
      } else if (evt.step === "gateway_restart") {
        setStatus((s) =>
          s.kind === "submitting"
            ? { kind: "submitting", stage: "gateway-restarting" }
            : s,
        );
      }
    };

    try {
      const res = pendingAgentId
        ? await agentsApi.reprovisionStream(pendingAgentId, onStep)
        : await agentsApi.createStream(
            {
              name: form.agentName.trim(),
              role: form.agentRole,
              adapterType: "openclaw",
              adapterConfig: form.adapterConfig,
              companyName: form.companyName.trim() || undefined,
            },
            onStep,
          );

      let company: CompanyDTO;
      if (res.company) {
        company = res.company;
      } else {
        const me = await meApi.get();
        if (!me.company) throw new Error("company_missing_after_create");
        company = me.company;
      }
      setPendingAgentId(null); // clear — the agent is fully provisioned now.
      setStatus({ kind: "complete", company });
    } catch (err) {
      let message = "launch_failed";
      let reason: string | undefined;
      let httpStatus: number | undefined;
      let agentIdFromError: string | undefined;
      if (err instanceof ApiError) {
        httpStatus = err.status;
        const body = err.body as
          | { error?: string; message?: string; reason?: string; agentId?: string }
          | undefined;
        // SSE stream rejects use the error frame's payload — the server
        // includes the agent row id whenever the failure happens after the
        // DB record is committed. Capture it so the next retry calls
        // reprovision instead of creating a duplicate.
        agentIdFromError = body?.agentId;
        reason = body?.reason;

        // Server-side fail() messages follow the format
        //   "<outer_code>: <inner_code> — <reason text>"
        // (outer = wrapping context, inner = the specific error). The UI's
        // prettifyError matches on the inner code (e.g. `gateway_restart_timeout`,
        // `device_pairing_required`), so unwrap before stashing.
        const raw = (body?.error ?? body?.message ?? "").trim();
        let code = raw;
        if (code.includes(":")) {
          const afterColon = raw.split(":").slice(1).join(":").trim();
          const dashIdx = afterColon.indexOf("—");
          if (dashIdx > 0) {
            code = afterColon.slice(0, dashIdx).trim();
            if (!reason) reason = afterColon.slice(dashIdx + 1).trim();
          } else {
            code = afterColon;
          }
        }

        if (code) {
          message = code;
        } else if (err.status === 409) message = "conflict";
        else if (err.status === 401) message = "gateway_unauthorized";
        else if (err.status === 502) message = "adapter_probe_failed";
        else if (err.status === 400) message = "invalid_body";
        else message = `api_${err.status}`;
      }
      if (agentIdFromError) setPendingAgentId(agentIdFromError);
      setStatus({
        kind: "error",
        message,
        reason,
        httpStatus,
        resume: resumeForError(message),
      });
    } finally {
      clearTimeout(provisioningHintTimer);
      if (restartHintTimer) clearTimeout(restartHintTimer);
    }
  }, [form, pendingAgentId]);

  return {
    status,
    form,
    probeResult,
    probing,
    pendingAgentId,
    setCompanyName,
    setAgentName,
    setAgentRole,
    setAdapterConfig,
    probeAdapter,
    launch,
    backToEdit,
    refresh,
  };
}
