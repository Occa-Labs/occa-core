"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Autocomplete } from "@/components/ui/autocomplete";
import { ApiError, adaptersApi, agentsApi } from "@/lib/api";
import type { AgentDTO } from "@occa/shared/types";
import { CSUITE_ROLES, ROLE_LABELS, ROLE_ORDER } from "./_shared";

type DeployStep = "form" | "probing" | "creating";

type DeployStepKey =
  | "creating_record"
  | "provisioning"
  | "gateway_restart"
  | "seeding_workspace"
  | "assigning_skills";

type DeployStepStatus = "pending" | "running" | "done" | "error";

const DEPLOY_STEPS: { key: DeployStepKey; label: string }[] = [
  { key: "creating_record", label: "Creating agent record" },
  { key: "provisioning", label: "Provisioning on gateway" },
  { key: "gateway_restart", label: "Waiting for gateway restart" },
  { key: "seeding_workspace", label: "Seeding workspace files" },
  { key: "assigning_skills", label: "Assigning skills" },
];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const INITIAL_STEP_STATUSES: Record<DeployStepKey, DeployStepStatus> = {
  creating_record: "pending",
  provisioning: "pending",
  gateway_restart: "pending",
  seeding_workspace: "pending",
  assigning_skills: "pending",
};

export function DeployAgentModal({
  open,
  onClose,
  onDeployed,
  agents,
}: {
  open: boolean;
  onClose: () => void;
  onDeployed: (agentId: string) => void;
  agents: AgentDTO[];
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  // Empty string = "auto-resolve from catalog". Non-empty = explicit
  // parent deployment id. Picker shown only when active candidates
  // exist (i.e. company has at least one non-CEO agent — first deploy
  // has nothing to pick from).
  const [parentAgentId, setParentAgentId] = useState<string>("");
  const [step, setStep] = useState<DeployStep>("form");
  const [probeResult, setProbeResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [stepStatuses, setStepStatuses] = useState<
    Record<DeployStepKey, DeployStepStatus>
  >(INITIAL_STEP_STATUSES);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [failedAgentId, setFailedAgentId] = useState<string | null>(null);

  const roleValid =
    role.trim().length > 0 &&
    /^[a-z0-9_-]+$/.test(role.trim()) &&
    role.trim().length <= 32;
  const canProbe =
    gatewayUrl.trim().length > 0 && apiKey.trim().length > 0 && step === "form";
  const canCreate =
    name.trim().length > 0 && roleValid && probeResult?.ok && step === "form";
  const busy = step !== "form";

  useEffect(() => {
    if (step !== "creating") return;
    const id = setInterval(
      () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      80,
    );
    return () => clearInterval(id);
  }, [step]);

  // Reset all form + flow state whenever the modal closes. Without this the
  // component (which stays mounted under Modal's open=false branch) keeps
  // the previous run's step="creating" + all-done stepStatuses, so a second
  // open shows "Finishing up…" with the Deploy button disabled. Clearing on
  // close also avoids leaking the previous gateway/api-key into a fresh form.
  useEffect(() => {
    if (open) return;
    setName("");
    setRole("");
    setGatewayUrl("");
    setApiKey("");
    setParentAgentId("");
    setStep("form");
    setProbeResult(null);
    setSubmitError(null);
    setStepStatuses({ ...INITIAL_STEP_STATUSES });
    setSpinnerFrame(0);
    setFailedAgentId(null);
  }, [open]);

  const handleProbe = useCallback(async () => {
    setStep("probing");
    setProbeResult(null);
    try {
      const res = await adaptersApi.probeOpenclaw({
        gatewayUrl: gatewayUrl.trim(),
        apiKey: apiKey.trim(),
      });
      setProbeResult({
        ok: res.ok,
        latencyMs: res.latencyMs,
        error: res.error,
      });
    } catch (e) {
      setProbeResult({
        ok: false,
        error:
          e instanceof ApiError
            ? ((e.body as { error?: string } | null)?.error ??
              `http_${e.status}`)
            : "network_error",
      });
    } finally {
      setStep("form");
    }
  }, [gatewayUrl, apiKey]);

  type StreamErrorBody = {
    message?: string;
    error?: string;
    agentId?: string;
    retryable?: boolean;
  } | null;

  const handleStreamError = useCallback((e: unknown) => {
    const body = e instanceof ApiError ? (e.body as StreamErrorBody) : null;
    const msg =
      body?.message ??
      body?.error ??
      (e instanceof ApiError ? `http_${e.status}` : "network_error");
    setSubmitError(msg);
    setFailedAgentId(body?.retryable && body.agentId ? body.agentId : null);
    setStepStatuses((prev) => {
      const running = (Object.keys(prev) as DeployStepKey[]).find(
        (k) => prev[k] === "running",
      );
      if (!running) return prev;
      return { ...prev, [running]: "error" };
    });
    setStep("form");
  }, []);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setStep("creating");
    setSubmitError(null);
    setFailedAgentId(null);
    setStepStatuses({ ...INITIAL_STEP_STATUSES });
    try {
      const res = await agentsApi.createStream(
        {
          name: name.trim(),
          role: role.trim(),
          adapterType: "openclaw",
          adapterConfig: {
            gatewayUrl: gatewayUrl.trim(),
            apiKey: apiKey.trim(),
          },
          parentAgentId: parentAgentId || null,
        },
        (evt) => {
          setStepStatuses((prev) => ({
            ...prev,
            [evt.step as DeployStepKey]:
              evt.status === "running" ? "running" : "done",
          }));
        },
      );
      // Auto-anchor was removed; manual anchor stays available from the
      // Overview tab for users who want to register an agent on-chain
      // later. Notify the parent and close the modal directly.
      onDeployed(res.agent.id);
    } catch (e) {
      handleStreamError(e);
    }
  }, [
    canCreate,
    name,
    role,
    gatewayUrl,
    apiKey,
    parentAgentId,
    handleStreamError,
    onDeployed,
  ]);

  const handleRetry = useCallback(async () => {
    if (!failedAgentId) return;
    setStep("creating");
    setSubmitError(null);
    setStepStatuses({ ...INITIAL_STEP_STATUSES, creating_record: "done" });
    try {
      const res = await agentsApi.reprovisionStream(failedAgentId, (evt) => {
        setStepStatuses((prev) => ({
          ...prev,
          [evt.step as DeployStepKey]:
            evt.status === "running" ? "running" : "done",
        }));
      });
      onDeployed(res.agent.id);
    } catch (e) {
      handleStreamError(e);
    }
  }, [failedAgentId, handleStreamError, onDeployed]);

  const footer = (
    <div className="flex items-center justify-end gap-3 px-5 py-3.5">
      <button
        onClick={onClose}
        disabled={step === "creating"}
        className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white/50 hover:text-white/80 transition-colors disabled:opacity-40"
      >
        Cancel
      </button>
      {step !== "creating" && (
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={!canCreate || busy}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-all disabled:opacity-35 disabled:cursor-not-allowed"
          style={{
            background:
              canCreate && !busy
                ? "linear-gradient(150deg, #059669 0%, #047857 100%)"
                : "rgba(255,255,255,0.08)",
          }}
        >
          {step === "probing" ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Verifying…
            </>
          ) : (
            <>
              <Plus className="size-3.5" /> Deploy agent
            </>
          )}
        </button>
      )}
    </div>
  );

  const activeStep = DEPLOY_STEPS.find(
    ({ key }) =>
      stepStatuses[key] === "running" || stepStatuses[key] === "error",
  );

  return (
    <Modal open={open} onClose={onClose} title="Deploy agent" footer={footer}>
      <div className="px-5 py-6 space-y-6">
        {/* Identity */}
        <section className="space-y-3">
          <h3 className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">
            Identity
          </h3>
          <div className="space-y-2.5">
            <div>
              <span className="text-[11px] text-white/50 mb-1.5 block">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Atlas, Nova, Rex…"
                disabled={busy}
                className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50"
              />
            </div>
            <Autocomplete
              label="Role"
              value={role}
              onChange={(v) =>
                setRole(v.toLowerCase().replace(/[^a-z0-9_-]/g, ""))
              }
              onSelect={(opt) => setRole(opt.value)}
              options={ROLE_ORDER.map((r) => ({
                value: r,
                description: ROLE_LABELS[r] ?? r,
                disabled:
                  CSUITE_ROLES.has(r) && agents.some((a) => a.role === r),
              }))}
              placeholder="ceo, eng, researcher…"
              disabled={busy}
              error={
                role && !roleValid
                  ? "Lowercase letters, numbers, _ and - only (max 32 chars)"
                  : undefined
              }
            />
            {/* Parent picker — only when active candidates exist + role
                is not CEO. Blank = auto-resolve from catalog. */}
            {role !== "ceo" &&
              agents.filter((a) => a.status === "active" && a.role !== role)
                .length > 0 && (
                <label className="block">
                  <span className="text-[11px] text-white/50 mb-1.5 block">
                    Reports to{" "}
                    <span className="text-white/30">
                      (optional — auto-resolved from catalog if blank)
                    </span>
                  </span>
                  <select
                    value={parentAgentId}
                    onChange={(e) => setParentAgentId(e.target.value)}
                    disabled={busy}
                    className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 transition disabled:opacity-50 cursor-pointer appearance-none"
                  >
                    <option value="">
                      Auto-resolve from role catalog
                    </option>
                    {agents
                      .filter(
                        (a) => a.status === "active" && a.role !== role,
                      )
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} — {ROLE_LABELS[a.role] ?? a.role}
                        </option>
                      ))}
                  </select>
                </label>
              )}
          </div>
        </section>

        {/* Divider */}
        <div style={{ height: "1px", background: "rgba(255,255,255,0.06)" }} />

        {/* Gateway credentials */}
        <section className="space-y-3">
          <h3 className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">
            Gateway credentials
          </h3>
          <div className="space-y-2.5">
            <label className="block">
              <span className="text-[11px] text-white/50 mb-1.5 block">
                Gateway URL
              </span>
              <input
                value={gatewayUrl}
                onChange={(e) => {
                  setGatewayUrl(e.target.value);
                  setProbeResult(null);
                  setFailedAgentId(null);
                }}
                placeholder="https://gateway.example.com"
                type="url"
                disabled={busy}
                className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50 font-mono"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-white/50 mb-1.5 block">
                API key
              </span>
              <input
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setProbeResult(null);
                  setFailedAgentId(null);
                }}
                placeholder="sk-…"
                type="password"
                disabled={busy}
                className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50 font-mono"
              />
            </label>
          </div>

          {/* Probe result */}
          {probeResult && (
            <div
              className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[12px] ${
                probeResult.ok
                  ? "bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/18"
                  : "bg-red-500/10 text-red-300 ring-1 ring-inset ring-red-500/18"
              }`}
            >
              {probeResult.ok ? (
                <>
                  <CheckCircle2 className="size-3.5 shrink-0" /> Connected —{" "}
                  {probeResult.latencyMs}ms
                </>
              ) : (
                <>
                  <AlertCircle className="size-3.5 shrink-0" />{" "}
                  {probeResult.error ?? "Connection failed"}
                </>
              )}
            </div>
          )}

          {step !== "creating" && (
            <button
              type="button"
              onClick={() => void handleProbe()}
              disabled={!canProbe}
              className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-medium text-white/65 hover:text-white/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: "rgba(255,255,255,0.065)",
                border: "1px solid rgba(255,255,255,0.09)",
              }}
            >
              {step === "probing" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Verifying…
                </>
              ) : (
                "Verify connection"
              )}
            </button>
          )}
        </section>

        {/* Active step indicator */}
        {step === "creating" && (
          <div className="flex items-center gap-2.5 pt-1">
            <span className="font-mono text-[13px] text-white/60 select-none shrink-0">
              {activeStep && stepStatuses[activeStep.key] === "error" ? (
                <span className="text-red-400">✗</span>
              ) : (
                SPINNER_FRAMES[spinnerFrame]
              )}
            </span>
            <span
              className={`text-[12px] font-medium ${activeStep && stepStatuses[activeStep.key] === "error" ? "text-red-300/80" : "animate-text-shine"}`}
            >
              {activeStep?.label ?? "Finishing up…"}
            </span>
          </div>
        )}

        {/* Submit error + retry */}
        {submitError && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[12px] text-red-300/85">
              <AlertCircle className="size-3.5 shrink-0" />
              {submitError}
            </p>
            {failedAgentId && (
              <button
                type="button"
                onClick={() => void handleRetry()}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-amber-300/80 hover:text-amber-200 transition-colors"
                style={{
                  background: "rgba(251,191,36,0.08)",
                  border: "1px solid rgba(251,191,36,0.18)",
                }}
              >
                <RefreshCw className="size-3 shrink-0" />
                Retry from failed step
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

