"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Autocomplete } from "@/components/ui/autocomplete";
import { ApiError, adaptersApi, agentsApi } from "@/lib/api";
import type { AgentDTO } from "@occa/shared/types";
import { useBatchAnchorAgents } from "@/features/chain/hooks/use-batch-anchor-agents";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import { prettifyAnchorError } from "@/features/chain/lib/anchor-errors";
import { CSUITE_ROLES, ROLE_LABELS, ROLE_ORDER } from "./_shared";

type DeployStep = "form" | "probing" | "creating" | "anchoring";

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
  // Holds the agent id returned by createStream once the SSE flow finishes.
  // Anchor flow needs it; "Continue without anchoring" needs it to bubble
  // the deploy up to the parent so reloadMe still fires.
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);

  // Single-agent on-chain anchor reuses the batch hook (it transparently
  // handles `pending.length === 1` with one signTransaction call).
  const anchor = useBatchAnchorAgents();
  const {
    stage: anchorStage,
    error: anchorError,
    prepare: anchorPrepare,
    signAndRegister: anchorSignAndRegister,
    reset: anchorReset,
  } = anchor;
  const walletStatus = useAnchorWallet();
  // Derive companyId from any existing agent in the company (CEO is always
  // present whenever this modal can be opened post-onboarding).
  const companyId = agents[0]?.companyId ?? null;

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
    if (step !== "creating" && step !== "anchoring") return;
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
    setStep("form");
    setProbeResult(null);
    setSubmitError(null);
    setStepStatuses({ ...INITIAL_STEP_STATUSES });
    setSpinnerFrame(0);
    setFailedAgentId(null);
    setCreatedAgentId(null);
    anchorReset();
  }, [open, anchorReset]);

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
        },
        (evt) => {
          setStepStatuses((prev) => ({
            ...prev,
            [evt.step as DeployStepKey]:
              evt.status === "running" ? "running" : "done",
          }));
        },
      );
      // Hand off to the anchor flow instead of closing the modal. The
      // effect below picks up `step === "anchoring"` + a resolved wallet
      // and chains prepare → signAndRegister; the parent only learns
      // about the new agent once anchor completes (or the user explicitly
      // skips via "Continue without anchoring").
      setCreatedAgentId(res.agent.id);
      setStep("anchoring");
    } catch (e) {
      handleStreamError(e);
    }
  }, [canCreate, name, role, gatewayUrl, apiKey, handleStreamError]);

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
      setCreatedAgentId(res.agent.id);
      setStep("anchoring");
    } catch (e) {
      handleStreamError(e);
    }
  }, [failedAgentId, handleStreamError]);

  // ── Anchor flow ────────────────────────────────────────────────────────
  // After the SSE create finishes we land in step="anchoring". When the
  // wallet resolves to "ready" and the hook is still idle, fire prepare —
  // the next effect chains signAndRegister as soon as prepare lands on
  // ready-to-sign. Prepare runs just before the wallet popup appears so
  // the Solana blockhash (~60s lifetime) doesn't expire while we wait
  // (see kickoff bug #5).
  useEffect(() => {
    if (step !== "anchoring") return;
    if (!createdAgentId || !companyId) return;
    if (anchorStage !== "idle") return;
    if (walletStatus.kind !== "ready") return;
    void anchorPrepare({ companyId, agentIds: [createdAgentId] });
  }, [
    step,
    createdAgentId,
    companyId,
    anchorStage,
    walletStatus,
    anchorPrepare,
  ]);

  useEffect(() => {
    if (step !== "anchoring") return;
    if (anchorStage !== "ready-to-sign") return;
    if (walletStatus.kind !== "ready") return;
    if (!companyId) return;
    void anchorSignAndRegister({ companyId, wallet: walletStatus.wallet });
  }, [step, anchorStage, walletStatus, companyId, anchorSignAndRegister]);

  useEffect(() => {
    if (step !== "anchoring") return;
    if (anchorStage !== "complete") return;
    if (!createdAgentId) return;
    onDeployed(createdAgentId);
  }, [step, anchorStage, createdAgentId, onDeployed]);

  const handleAnchorRetry = useCallback(() => {
    anchorReset();
  }, [anchorReset]);

  const handleAnchorSkip = useCallback(() => {
    if (!createdAgentId) return;
    // Agent is provisioned in DB+gateway; only the on-chain anchor is
    // missing. AnchorReminderBanner in OsShell surfaces unanchored agents
    // so the user can finish later from settings.
    onDeployed(createdAgentId);
  }, [createdAgentId, onDeployed]);

  const anchorBusy =
    anchorStage === "preparing" ||
    anchorStage === "awaiting-signature" ||
    anchorStage === "deriving-keypairs" ||
    anchorStage === "registering";

  const footer = (
    <div className="flex items-center justify-end gap-3 px-5 py-3.5">
      {step === "anchoring" ? (
        <button
          onClick={handleAnchorSkip}
          disabled={anchorBusy}
          className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white/50 hover:text-white/80 transition-colors disabled:opacity-40"
          title="You can anchor this agent later from settings."
        >
          Continue without anchoring
        </button>
      ) : (
        <button
          onClick={onClose}
          disabled={step === "creating"}
          className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white/50 hover:text-white/80 transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
      )}
      {step !== "creating" && step !== "anchoring" && (
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
      {step === "anchoring" && anchorError && (
        <button
          type="button"
          onClick={handleAnchorRetry}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-all"
          style={{
            background: "linear-gradient(150deg, #0ea5e9 0%, #0369a1 100%)",
          }}
        >
          <RefreshCw className="size-3.5" /> Retry anchor
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

        {/* Anchor step — runs after the SSE create finishes. The chain
         *  flow opens a single wallet popup and submits the combined
         *  identity + deployment tx. AnchorReminderBanner picks up
         *  unanchored agents if the user skips. */}
        {step === "anchoring" && (
          <AnchorStepPanel
            stage={anchorStage}
            error={
              anchorError
                ? {
                    code: anchorError.code,
                    ...prettifyAnchorError(anchorError.code),
                  }
                : null
            }
            walletStatus={walletStatus.kind}
            spinner={SPINNER_FRAMES[spinnerFrame]}
          />
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

type AnchorStage =
  | "idle"
  | "preparing"
  | "ready-to-sign"
  | "awaiting-signature"
  | "deriving-keypairs"
  | "registering"
  | "complete";

function AnchorStepPanel({
  stage,
  error,
  walletStatus,
  spinner,
}: {
  stage: AnchorStage;
  error: { code: string; headline: string; hint: string } | null;
  walletStatus: "loading" | "no-wallet" | "mismatch" | "ready";
  spinner: string;
}) {
  const busyLabel =
    stage === "preparing"
      ? "Reserving on-chain slot…"
      : stage === "awaiting-signature"
        ? "Waiting for wallet signature…"
        : stage === "deriving-keypairs"
          ? "Deriving keypair…"
          : stage === "registering"
            ? "Submitting on-chain tx…"
            : stage === "complete"
              ? "Anchored on Solana"
              : walletStatus === "loading"
                ? "Resolving wallet…"
                : walletStatus !== "ready"
                  ? "Wallet unavailable"
                  : "Anchoring on Solana…";

  return (
    <div className="rounded-xl border border-white/10 bg-white/4 px-4 py-3 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="size-8 shrink-0 rounded-full bg-cyan-400/15 flex items-center justify-center">
          <Link2 className="size-4 text-cyan-200" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-white/90">
            Anchor agent on Solana
          </div>
          <div className="text-[11px] text-white/55 mt-0.5">
            One signature derives an on-chain keypair and registers the
            agent in a single combined transaction.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[13px] text-white/60 select-none shrink-0">
          {error ? (
            <span className="text-red-400">✗</span>
          ) : stage === "complete" ? (
            <CheckCircle2 className="size-3.5 text-emerald-400" />
          ) : (
            spinner
          )}
        </span>
        <span
          className={`text-[12px] font-medium ${
            error
              ? "text-red-300/80"
              : stage === "complete"
                ? "text-emerald-300/85"
                : "animate-text-shine"
          }`}
        >
          {busyLabel}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2.5 space-y-1.5">
          <div className="flex items-start gap-2">
            <p className="text-[11px] text-rose-200/95 leading-snug flex-1 min-w-0">
              {error.headline}
            </p>
            <span className="font-mono text-[10px] text-rose-300/80 bg-rose-500/15 px-1.5 py-0.5 rounded shrink-0">
              {error.code}
            </span>
          </div>
          <p className="text-[11px] text-white/65 leading-relaxed">
            {error.hint}
          </p>
        </div>
      )}

      {!error && walletStatus !== "ready" && walletStatus !== "loading" && (
        <div className="text-[11px] text-amber-300/85 bg-amber-500/10 rounded-md px-2.5 py-1.5">
          {walletStatus === "no-wallet"
            ? "Connect a Solana wallet to anchor — or continue without anchoring and finish later."
            : "Connected wallet doesn't match your OCCA identity. Reconnect with the original wallet, or continue without anchoring."}
        </div>
      )}
    </div>
  );
}
