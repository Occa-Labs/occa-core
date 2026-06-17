"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Server,
  Terminal,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { Autocomplete } from "@/components/ui/autocomplete";
import { AdapterCredsHelp } from "./adapter-creds-help";
import { ApiError, adaptersApi, agentsApi } from "@/lib/api";
import type {
  AdapterConfig,
  AdapterType,
  AgentDTO,
} from "@occa/shared/types";
import { CLAUDE_CODE_MODELS } from "@occa/shared/types";
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

// Fields a caller can pre-seed when opening the modal (e.g. from a CEO
// deployment proposal). Credentials are deliberately absent — the gateway
// endpoint + token are always operator-entered here, never pre-filled.
export interface DeployPrefill {
  name?: string;
  role?: string;
  adapterType?: AdapterType;
  // Skills the proposal suggested. NOT a modal input (skills are assigned
  // post-deploy via the Skills tab) — shown as a read-only hint only.
  proposedSkills?: string[];
}

export function DeployAgentModal({
  open,
  onClose,
  onDeployed,
  agents,
  prefill = null,
  showBilling = true,
  showRole = true,
  companyId = null,
}: {
  open: boolean;
  onClose: () => void;
  onDeployed: (agentId: string) => void;
  agents: AgentDTO[];
  prefill?: DeployPrefill | null;
  /** Set for a company-origin deploy (company OS Agents window, CEO
   *  proposal): the new agent attaches to this company. Omitted for the
   *  personal Home flow, which creates an idle, company-less agent. */
  companyId?: string | null;
  /** Hide the per-task billing rate. Task rates are a company concern, so
   *  the personal home's Add-agent flow turns this off. */
  showBilling?: boolean;
  /** Hide the org role picker. Role is an org-hierarchy concern; the
   *  personal home's Add-agent flow turns this off and tags the agent
   *  "specialist" in metadata. */
  showRole?: boolean;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  // Free-text specialty ("specialist for X"). Intrinsic to the agent.
  const [persona, setPersona] = useState("");
  // Adapter tab selection. Default to openclaw — matches the onboarding
  // stepper default and keeps post-onboarding muscle memory intact.
  const [adapterType, setAdapterType] = useState<AdapterType>("openclaw");
  // OpenClaw form state — kept on its own slot so switching tabs back
  // and forth doesn't wipe what the operator already typed.
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  // Hermes form state — public HTTPS URL of the operator's Hermes VPS
  // (running `hermes gateway` with API_SERVER_ENABLED) + the bearer
  // token they set in API_SERVER_KEY. Same shape as OpenClaw because
  // both runtimes now authenticate via HTTP + bearer.
  const [hermesGatewayUrl, setHermesGatewayUrl] = useState("");
  const [hermesApiKey, setHermesApiKey] = useState("");
  // Claude Code form state — the model (default "sonnet" for cost, "opus"
  // for quality) plus an OPTIONAL remote gateway (BYORT): leave blank to run
  // locally on the host login, or point at a Claude Gateway on another box.
  const [model, setModel] = useState("sonnet");
  const [ccGatewayUrl, setCcGatewayUrl] = useState("");
  const [ccApiKey, setCcApiKey] = useState("");
  // Optional flat per-task invoice rate, entered in SOL. Empty = no rate
  // (operator can set it later from the Wallet tab).
  const [taskRateSol, setTaskRateSol] = useState("");
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

  // "How to get these" help popover, anchored to the info button next to
  // the Runtime credentials header. Content switches per adapter.
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpRect, setHelpRect] = useState<DOMRect | null>(null);
  const helpTriggerRef = useRef<HTMLButtonElement>(null);
  const openHelp = useCallback(() => {
    setHelpRect(helpTriggerRef.current?.getBoundingClientRect() ?? null);
    setHelpOpen(true);
  }, []);

  // When the role picker is hidden (personal home flow), the agent is
  // tagged "specialist" in metadata and role validation is a no-op.
  const PERSONAL_DEFAULT_ROLE = "specialist";
  const effectiveRole = showRole ? role.trim() : PERSONAL_DEFAULT_ROLE;
  const roleValid =
    !showRole ||
    (role.trim().length > 0 &&
      /^[a-z0-9_-]+$/.test(role.trim()) &&
      role.trim().length <= 32);
  // Rate is optional. When filled it must parse to a finite non-negative
  // number; empty stays valid (no rate set).
  const taskRateValid =
    taskRateSol.trim() === "" ||
    (Number.isFinite(Number(taskRateSol)) && Number(taskRateSol) >= 0);
  const credsFilled =
    adapterType === "claude-code"
      ? ccGatewayUrl.trim().length > 0 && ccApiKey.trim().length > 0
      : adapterType === "openclaw"
        ? gatewayUrl.trim().length > 0 && apiKey.trim().length > 0
        : hermesGatewayUrl.trim().length > 0 && hermesApiKey.trim().length > 0;
  const canProbe = credsFilled && step === "form";
  const canCreate =
    name.trim().length > 0 &&
    roleValid &&
    taskRateValid &&
    probeResult?.ok &&
    step === "form";
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
    setPersona("");
    setAdapterType("openclaw");
    setGatewayUrl("");
    setApiKey("");
    setHermesGatewayUrl("");
    setHermesApiKey("");
    setModel("sonnet");
    setTaskRateSol("");
    setParentAgentId("");
    setStep("form");
    setProbeResult(null);
    setSubmitError(null);
    setStepStatuses({ ...INITIAL_STEP_STATUSES });
    setSpinnerFrame(0);
    setFailedAgentId(null);
  }, [open]);

  // Seed catalog-constrained fields from a proposal when the modal opens.
  // NEVER seeds credentials — the operator always types the gateway URL +
  // token themselves (the security invariant). The close-reset effect above
  // still wipes everything when the modal closes, so a manual reopen starts
  // blank.
  useEffect(() => {
    if (!open || !prefill) return;
    if (prefill.name) setName(prefill.name);
    if (prefill.role) setRole(prefill.role);
    if (prefill.adapterType) setAdapterType(prefill.adapterType);
  }, [open, prefill]);

  // Switching tabs invalidates a stale probe — credentials are different
  // between adapters so the old "ok" no longer applies.
  const switchAdapter = useCallback((next: AdapterType) => {
    setAdapterType((prev) => {
      if (prev === next) return prev;
      setProbeResult(null);
      setFailedAgentId(null);
      return next;
    });
  }, []);

  const handleProbe = useCallback(async () => {
    setStep("probing");
    setProbeResult(null);
    try {
      const res =
        adapterType === "claude-code"
          ? await adaptersApi.probeClaudeCode({
              model,
              ...(ccGatewayUrl.trim() && ccApiKey.trim()
                ? { gatewayUrl: ccGatewayUrl.trim(), apiKey: ccApiKey.trim() }
                : {}),
            })
          : adapterType === "openclaw"
            ? await adaptersApi.probeOpenclaw({
                gatewayUrl: gatewayUrl.trim(),
                apiKey: apiKey.trim(),
              })
            : await adaptersApi.probeHermes({
                gatewayUrl: hermesGatewayUrl.trim(),
                apiKey: hermesApiKey.trim(),
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
  }, [
    adapterType,
    gatewayUrl,
    apiKey,
    hermesGatewayUrl,
    hermesApiKey,
    model,
    ccGatewayUrl,
    ccApiKey,
  ]);

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
      const adapterConfig: AdapterConfig =
        adapterType === "claude-code"
          ? {
              model,
              ...(ccGatewayUrl.trim() && ccApiKey.trim()
                ? { gatewayUrl: ccGatewayUrl.trim(), apiKey: ccApiKey.trim() }
                : {}),
            }
          : adapterType === "openclaw"
            ? { gatewayUrl: gatewayUrl.trim(), apiKey: apiKey.trim() }
            : {
                gatewayUrl: hermesGatewayUrl.trim(),
                apiKey: hermesApiKey.trim(),
              };
      const res = await agentsApi.createStream(
        {
          name: name.trim(),
          role: effectiveRole,
          persona: persona.trim() || null,
          adapterType,
          adapterConfig,
          // Company-origin deploy attaches to this company; null = idle.
          companyId: companyId ?? null,
          parentAgentId: parentAgentId || null,
          // SOL → lamports. Empty input = null (no rate set yet).
          taskRateLamports:
            taskRateSol.trim() === ""
              ? null
              : Math.round(Number(taskRateSol) * 1_000_000_000),
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
    adapterType,
    gatewayUrl,
    apiKey,
    hermesGatewayUrl,
    hermesApiKey,
    model,
    ccGatewayUrl,
    ccApiKey,
    parentAgentId,
    taskRateSol,
    companyId,
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
            <div>
              <span className="text-[11px] text-white/50 mb-1.5 block">
                Specialist for{" "}
                <span className="text-white/30">
                  (what this agent is good at — shapes its skills + behavior)
                </span>
              </span>
              <textarea
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                placeholder="e.g. crypto market research, Solidity audits, growth copywriting…"
                rows={2}
                disabled={busy}
                className="w-full resize-none rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50"
              />
            </div>
            {showRole && (
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
            )}
            {/* Parent picker — only when active candidates exist + role
                is not CEO. Blank = auto-resolve from catalog. */}
            {showRole &&
              role !== "ceo" &&
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
            {prefill?.proposedSkills && prefill.proposedSkills.length > 0 && (
              <p className="text-[11px] leading-relaxed text-white/40">
                Proposed skills:{" "}
                <span className="text-white/60">
                  {prefill.proposedSkills.join(", ")}
                </span>
                . Assign them from the agent&apos;s Skills tab after deploy.
              </p>
            )}
          </div>
        </section>

        {/* Divider */}
        {showBilling && (
          <>
            <div
              style={{ height: "1px", background: "rgba(255,255,255,0.06)" }}
            />

            {/* Billing */}
            <section className="space-y-3">
              <h3 className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">
                Billing
              </h3>
              <label className="block">
                <span className="text-[11px] text-white/50 mb-1.5 block">
                  Task rate{" "}
                  <span className="text-white/30">
                    (optional — SOL invoiced per completed task)
                  </span>
                </span>
                <div className="relative">
                  <input
                    value={taskRateSol}
                    onChange={(e) =>
                      setTaskRateSol(e.target.value.replace(/[^0-9.]/g, ""))
                    }
                    placeholder="0.05"
                    inputMode="decimal"
                    disabled={busy}
                    className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 pr-14 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50 font-mono"
                  />
                  <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] text-white/35 font-medium">
                    SOL
                  </span>
                </div>
                <span className="text-[11px] text-white/30 mt-1.5 block">
                  Leave blank to set later from the agent&apos;s Wallet tab.
                </span>
              </label>
            </section>
          </>
        )}

        {/* Divider */}
        <div style={{ height: "1px", background: "rgba(255,255,255,0.06)" }} />

        {/* Runtime credentials */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">
              Runtime credentials
            </h3>
            {/* Tab bar — picks the adapter for THIS agent. Different
                agents in the same company may run on different runtimes. */}
            <div className="flex items-center gap-1 rounded-lg bg-white/5 p-0.5 ring-1 ring-inset ring-white/8">
              <AdapterTab
                active={adapterType === "openclaw"}
                disabled={busy}
                icon={<Network className="size-3" />}
                label="OpenClaw"
                onClick={() => switchAdapter("openclaw")}
              />
              <AdapterTab
                active={adapterType === "hermes"}
                disabled={busy}
                icon={<Server className="size-3" />}
                label="Hermes"
                onClick={() => switchAdapter("hermes")}
              />
              <AdapterTab
                active={adapterType === "claude-code"}
                disabled={busy}
                icon={<Terminal className="size-3" />}
                label="Claude Code"
                onClick={() => switchAdapter("claude-code")}
              />
            </div>
          </div>

          {/* Visible help trigger — sits right where the user enters the
              creds so it actually gets noticed, not a tiny header icon.
              claude-code has no creds, so it shows a note instead. */}
          {adapterType === "claude-code" ? (
            <p className="text-[11px] text-white/40 leading-relaxed">
              Runs on a Claude subscription via a Claude Gateway on the host
              box (BYORT). Set the gateway URL + bearer below. For local dev,
              run a gateway on localhost.
            </p>
          ) : (
            <button
              ref={helpTriggerRef}
              type="button"
              onClick={openHelp}
              className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-[11.5px] text-white/45 transition-colors hover:bg-white/5 hover:text-white/75"
              style={{ border: "1px dashed rgba(255,255,255,0.10)" }}
            >
              <HelpCircle className="size-3.5 shrink-0" />
              Where do I find the{" "}
              {adapterType === "openclaw" ? "OpenClaw" : "Hermes"} Gateway URL
              and API key?
            </button>
          )}

          {adapterType === "claude-code" ? (
            <div className="space-y-2.5">
              <label className="block">
                <span className="text-[11px] text-white/50 mb-1.5 block">
                  Model
                </span>
                <select
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setProbeResult(null);
                    setFailedAgentId(null);
                  }}
                  disabled={busy}
                  className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 transition disabled:opacity-50 font-mono"
                >
                  {CLAUDE_CODE_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="space-y-2 rounded-xl ring-1 ring-inset ring-white/10 bg-white/2 p-3">
                <span className="text-[11px] text-white/50 block">
                  Claude Gateway (BYORT)
                </span>
                <input
                  value={ccGatewayUrl}
                  onChange={(e) => {
                    setCcGatewayUrl(e.target.value);
                    setProbeResult(null);
                    setFailedAgentId(null);
                  }}
                  placeholder="https://claude.your-box.com"
                  type="url"
                  disabled={busy}
                  className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 transition disabled:opacity-50 font-mono"
                />
                <input
                  value={ccApiKey}
                  onChange={(e) => {
                    setCcApiKey(e.target.value);
                    setProbeResult(null);
                    setFailedAgentId(null);
                  }}
                  placeholder="gateway bearer (required with a gateway)"
                  type="password"
                  disabled={busy}
                  className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 transition disabled:opacity-50 font-mono"
                />
              </div>
            </div>
          ) : adapterType === "openclaw" ? (
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
          ) : (
            <div className="space-y-2.5">
              <label className="block">
                <span className="text-[11px] text-white/50 mb-1.5 block">
                  Gateway URL
                </span>
                <input
                  value={hermesGatewayUrl}
                  onChange={(e) => {
                    setHermesGatewayUrl(e.target.value);
                    setProbeResult(null);
                    setFailedAgentId(null);
                  }}
                  placeholder="https://hermes.example.com"
                  type="url"
                  disabled={busy}
                  className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50 font-mono"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-white/50 mb-1.5 block">
                  API_SERVER_KEY bearer
                </span>
                <input
                  value={hermesApiKey}
                  onChange={(e) => {
                    setHermesApiKey(e.target.value);
                    setProbeResult(null);
                    setFailedAgentId(null);
                  }}
                  placeholder="—"
                  type="password"
                  disabled={busy}
                  className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50 font-mono"
                />
              </label>
            </div>
          )}

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
            {/* Retry button only appears for openclaw failures because
                Phase 0 reprovision is openclaw-only (server returns 501
                for hermes, see lifecycle.ts). The hermes path emits
                `retryable: false` so `failedAgentId` stays null and this
                block hides naturally. */}
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

      {helpOpen && (
        <FloatingPanel
          title={
            adapterType === "openclaw"
              ? "OpenClaw credentials"
              : "Hermes credentials"
          }
          subtitle="Where to get the URL + key"
          triggerRect={helpRect}
          width={420}
          zIndex={300}
          backdrop="transparent"
          onClose={() => setHelpOpen(false)}
        >
          <AdapterCredsHelp adapter={adapterType} />
        </FloatingPanel>
      )}
    </Modal>
  );
}

function AdapterTab({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-emerald-500/15 text-emerald-100 ring-1 ring-inset ring-emerald-400/30"
          : "text-white/55 hover:text-white/85"
      }`}
    >
      <span className={active ? "text-emerald-300" : "text-white/45"}>
        {icon}
      </span>
      {label}
    </button>
  );
}

