"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { ApiError, agentsApi } from "@/lib/api";
import { formatRoleLabel } from "@/lib/format-role";
import type { AgentDTO } from "@occa/shared/types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { ZONE_DESKS, type SeatingZone } from "@occa/shared/seating";
import { Modal } from "@/components/ui/modal";
import { MODEL_POOL } from "@/features/theater/constants";
import { useBatchAnchorAgents } from "@/features/chain/hooks/use-batch-anchor-agents";
import { useAnchorIdentity } from "@/features/chain/hooks/use-anchor-identity";
import { useAnchorWallet } from "@/features/chain/hooks/use-anchor-wallet";
import { prettifyAnchorError } from "@/features/chain/lib/anchor-errors";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatWhen } from "./_shared";

export function OverviewTab({
  agent,
  agents,
  onReloadMe,
}: {
  agent: AgentDTO;
  agents: AgentDTO[];
  onReloadMe: () => Promise<void> | void;
}) {
  const [seatModalOpen, setSeatModalOpen] = useState(false);

  // Resolve parent name from the flat agents list. CEO has no parent
  // by design (top of the chart); other agents fall back to "—" when
  // parent isn't found in the current snapshot (race vs reload).
  const parentAgent = agent.parentAgentId
    ? agents.find((a) => a.id === agent.parentAgentId)
    : null;
  const reportsToValue =
    agent.role === CEO_ROLE
      ? "— (top of the chart)"
      : parentAgent
        ? `${parentAgent.name} (${formatRoleLabel(parentAgent.role)})`
        : agent.parentAgentId
          ? "—"
          : "— (top-level)";

  const rows: { label: string; value: string }[] = [
    { label: "Name", value: agent.name },
    { label: "Role", value: formatRoleLabel(agent.role) },
    { label: "Reports to", value: reportsToValue },
    { label: "Adapter", value: agent.adapterType },
    { label: "External ID", value: agent.externalAgentId ?? "—" },
    { label: "Created", value: formatWhen(agent.createdAt) },
    { label: "Assigned skills", value: String(agent.desiredSkills.length) },
  ];

  // Reprovision banner is shown only when something is actually wrong on
  // the gateway side. `ready` agents already have an externalAgentId and
  // shouldn't be re-touched (would burn a config.patch slot for no gain).
  // `pending` is also stuck-state surfaced post-kickoff for hires that
  // never made it past the gateway rate limit.
  const needsReprovision =
    agent.provisioningState === "failed" ||
    agent.provisioningState === "pending";

  // On-chain anchor panel surfaces for any gateway-ready agent that hasn't
  // been registered on Solana yet. CEO uses the 3-phase flow (company →
  // identity → deployment, 3 wallet signatures) because anchoring CEO
  // implicitly anchors the company itself. Non-CEO uses the combined
  // identity+deployment flow (1 wallet signature) which assumes the
  // company is already anchored. `agentChainTxSignature` is the reliable
  // "actually broadcast" signal — `agentPda` is pre-written by the prepare
  // route and would false-positive on un-anchored rows.
  const needsAnchor =
    agent.provisioningState === "ready" &&
    agent.agentChainTxSignature === null;
  const isCeo = agent.role === CEO_ROLE;

  return (
    <div className="p-5 space-y-1">
      {/* Blocker panels (reprovision / anchor) render at the top so users
       *  see them on first scroll position — these gate downstream features
       *  (Wallet tab disabled until anchor confirms; gateway calls fail
       *  while reprovision is needed). Placing them under the metadata
       *  rows hid them on small viewports. */}
      {needsReprovision && (
        <div className="pb-4">
          <ReprovisionPanel agent={agent} onReloadMe={onReloadMe} />
        </div>
      )}
      {!needsReprovision && needsAnchor && (
        <div className="pb-4">
          {/* key={agent.id} resets the anchor hook's state when the user
           *  switches between agents — otherwise the previous agent's
           *  prepRef / stage would leak across selections. */}
          {isCeo ? (
            <AnchorCeoPanel
              key={agent.id}
              agent={agent}
              onReloadMe={onReloadMe}
            />
          ) : (
            <AnchorAgentPanel
              key={agent.id}
              agent={agent}
              onReloadMe={onReloadMe}
            />
          )}
        </div>
      )}
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[140px_1fr] gap-3 py-2 border-b border-white/6 last:border-0"
        >
          <div className="text-xs text-white/40">{r.label}</div>
          <div className="text-xs text-white/80 font-mono truncate">
            {r.value}
          </div>
        </div>
      ))}
      <SeatRow agent={agent} onChangeClick={() => setSeatModalOpen(true)} />
      <CharacterRow agent={agent} onReloadMe={onReloadMe} />
      <SeatPickerModal
        open={seatModalOpen}
        agent={agent}
        agents={agents}
        onClose={() => setSeatModalOpen(false)}
        onReloadMe={onReloadMe}
      />
    </div>
  );
}

// ── Seat row + picker modal ──────────────────────────────────────────────
//
// Surfaces the agent's current 3D office desk and lets the operator move
// them. Reserved zones (meeting / lobby / exec) ARE available — manual
// override bypasses the auto-assign skip rule. Desks already taken by
// another agent in the company are shown but disabled (the partial unique
// index on `(company_id, workstation_id)` would reject the PATCH anyway;
// disabling avoids a round-trip).

function SeatRow({
  agent,
  onChangeClick,
}: {
  agent: AgentDTO;
  onChangeClick: () => void;
}) {
  const zone = agent.workstationId ? zoneForDesk(agent.workstationId) : null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 border-b border-white/6">
      <div className="text-xs text-white/40">Seat</div>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-white/80 font-mono truncate">
          {agent.workstationId ?? "—"}
        </span>
        {zone && (
          <span className="text-[10px] text-white/35 font-mono">
            ({zoneLabelFor(zone)})
          </span>
        )}
        <button
          type="button"
          onClick={onChangeClick}
          className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-white/75 transition hover:bg-white/10 hover:text-white"
        >
          <Pencil className="size-3" />
          Change
        </button>
      </div>
    </div>
  );
}

// ── Character row ────────────────────────────────────────────────────────
//
// Inline native <select> for the 3D character model. Empty value = revert
// to the auto-pick from `buildAgentModelMap`. Patches via the same agents
// PATCH endpoint as the seat picker.

function modelDisplayName(url: string): string {
  const file = url.split("/").pop() ?? url;
  const stem = file.replace(/\.glb$/, "");
  return stem
    .split("_")
    .map((part) => {
      if (/^\d+$/.test(part)) return String(parseInt(part, 10));
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function CharacterRow({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = agent.modelOverride ?? "";

  const handleChange = useCallback(
    async (next: string) => {
      setSubmitting(true);
      setError(null);
      try {
        await agentsApi.patch(agent.id, {
          modelOverride: next === "" ? null : next,
        });
        await onReloadMe();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed.");
      } finally {
        setSubmitting(false);
      }
    },
    [agent.id, onReloadMe],
  );

  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 border-b border-white/6">
      <div className="text-xs text-white/40">Character</div>
      <div className="flex items-center gap-2 min-w-0">
        <select
          value={value}
          disabled={submitting}
          onChange={(e) => handleChange(e.target.value)}
          className="flex-1 min-w-0 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/85 focus:outline-none focus:ring-1 focus:ring-white/25 disabled:opacity-50"
        >
          <option value="">Auto (default)</option>
          {MODEL_POOL.map((url) => (
            <option key={url} value={url}>
              {modelDisplayName(url)}
            </option>
          ))}
        </select>
        {submitting && (
          <Loader2 className="size-3 animate-spin text-white/50" />
        )}
        {error && (
          <span className="text-[10px] text-red-300/80 truncate" title={error}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function SeatPickerModal({
  open,
  agent,
  agents,
  onClose,
  onReloadMe,
}: {
  open: boolean;
  agent: AgentDTO;
  agents: AgentDTO[];
  onClose: () => void;
  onReloadMe: () => Promise<void> | void;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Map desk → owning agent (other than this one). Used to disable taken
  // seats and show the occupant's name in the row tooltip / label.
  const occupants = useMemo(() => {
    const m = new Map<string, AgentDTO>();
    for (const a of agents) {
      if (a.id === agent.id) continue;
      if (!a.workstationId) continue;
      m.set(a.workstationId, a);
    }
    return m;
  }, [agents, agent.id]);

  const handlePick = useCallback(
    async (deskId: string) => {
      if (deskId === agent.workstationId) {
        onClose();
        return;
      }
      setSubmitting(deskId);
      setError(null);
      try {
        await agentsApi.patch(agent.id, { workstationId: deskId });
        await onReloadMe();
        onClose();
      } catch (err) {
        const code =
          err instanceof ApiError &&
          err.body &&
          typeof err.body === "object" &&
          "error" in err.body
            ? String((err.body as Record<string, unknown>).error)
            : null;
        setError(
          code === ERROR_CODES.WORKSTATION_OCCUPIED
            ? "That desk is already taken — pick another."
            : code === ERROR_CODES.WORKSTATION_NOT_FOUND
              ? "Unknown desk."
              : err instanceof Error
                ? err.message
                : "Move failed.",
        );
        setSubmitting(null);
      }
    },
    [agent.id, agent.workstationId, onClose, onReloadMe],
  );

  return (
    <Modal open={open} onClose={onClose} title="Change seat">
      <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
        {error && (
          <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </div>
        )}
        {(Object.keys(ZONE_DESKS) as SeatingZone[]).map((zone) => (
          <ZoneSection
            key={zone}
            zone={zone}
            currentDeskId={agent.workstationId}
            occupants={occupants}
            submittingDeskId={submitting}
            onPick={handlePick}
          />
        ))}
      </div>
    </Modal>
  );
}

function ZoneSection({
  zone,
  currentDeskId,
  occupants,
  submittingDeskId,
  onPick,
}: {
  zone: SeatingZone;
  currentDeskId: string | null;
  occupants: Map<string, AgentDTO>;
  submittingDeskId: string | null;
  onPick: (deskId: string) => void;
}) {
  const desks = ZONE_DESKS[zone];
  const isReserved =
    zone === "exec" || zone === "reserved_meeting" || zone === "reserved_lobby";
  return (
    <section className="space-y-1.5">
      <header className="flex items-baseline gap-2 px-1 pt-1">
        <h4 className="text-[10px] uppercase tracking-widest text-white/45 font-semibold">
          {zoneLabelFor(zone)}
        </h4>
        {isReserved && (
          <span className="text-[9px] uppercase tracking-wider text-amber-300/65">
            reserved
          </span>
        )}
        <span className="text-[10px] text-white/30 ml-auto">
          {desks.length} {desks.length === 1 ? "seat" : "seats"}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-1.5">
        {desks.map((deskId) => {
          const occupant = occupants.get(deskId);
          const isCurrent = deskId === currentDeskId;
          const isTaken = !!occupant;
          const isSubmitting = submittingDeskId === deskId;
          const disabled = isTaken && !isCurrent;
          return (
            <button
              key={deskId}
              type="button"
              disabled={disabled || submittingDeskId !== null}
              onClick={() => onPick(deskId)}
              className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] transition ring-1 ring-inset ${
                isCurrent
                  ? "bg-emerald-500/15 ring-emerald-500/35 text-emerald-200"
                  : disabled
                    ? "bg-white/2 ring-white/5 text-white/30 cursor-not-allowed"
                    : "bg-white/5 ring-white/10 text-white/80 hover:bg-white/10 hover:text-white"
              }`}
            >
              <span className="font-mono truncate">{deskId}</span>
              <span className="shrink-0 text-[10px]">
                {isSubmitting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : isCurrent ? (
                  "current"
                ) : isTaken ? (
                  <span className="text-white/40 truncate max-w-20">
                    {occupant!.name}
                  </span>
                ) : (
                  <span className="text-emerald-400/60">free</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function zoneForDesk(deskId: string): SeatingZone | null {
  for (const [zone, desks] of Object.entries(ZONE_DESKS) as [
    SeatingZone,
    readonly string[],
  ][]) {
    if (desks.includes(deskId)) return zone;
  }
  return null;
}

const ZONE_LABELS: Record<SeatingZone, string> = {
  exec: "Executive",
  engineering: "Engineering",
  product_design: "Product / Design",
  marketing_growth: "Marketing / Growth",
  editorial_content: "Editorial / Content",
  operations_admin: "Operations / Admin",
  data_research: "Data / Research",
  web3: "Web3",
  reserved_meeting: "Meeting Rooms",
  reserved_lobby: "Lobby",
};

function zoneLabelFor(zone: SeatingZone): string {
  return ZONE_LABELS[zone];
}

// Inline panel surfaced inside the Overview tab for agents whose initial
// provision didn't stick on the gateway (state=`failed` or `pending`).
// Wraps the existing `agentsApi.reprovisionStream` so the user can retry
// without leaving the agent detail. Streamed step events update a single
// status line; on success the panel briefly shows a confirmation before
// the parent unmounts it (provisioningState flips to "ready" → the
// banner condition stops matching).
//
// Visual states:
//   idle      — banner with the original DB error (if any) + Retry button
//   running   — banner shows current step, hides the original error
//   success   — banner flips green with checkmark for ~1.2s before unmount
//   error     — banner returns to amber, shows the new retry error
function ReprovisionPanel({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  type State =
    | { kind: "idle" }
    | { kind: "running"; step: string }
    | { kind: "success" }
    | { kind: "error"; message: string };

  const [state, setState] = useState<State>({ kind: "idle" });

  const handleReprovision = useCallback(async () => {
    setState({ kind: "running", step: "Starting…" });
    try {
      await agentsApi.reprovisionStream(agent.id, (evt) => {
        if (evt.status === "running") {
          setState({ kind: "running", step: prettyStep(evt.step) });
        }
      });
      setState({ kind: "success" });
      await onReloadMe();
      // Parent unmounts us when provisioningState flips to "ready" via
      // the reload above; if reload races us we briefly stay in success
      // until the next render.
    } catch (err) {
      const message =
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "error" in err.body
            ? String((err.body as Record<string, unknown>).error)
            : `api_${err.status}`
          : err instanceof Error
            ? err.message
            : "reprovision_failed";
      setState({ kind: "error", message });
    }
  }, [agent.id, onReloadMe]);

  const isSuccess = state.kind === "success";
  const isRunning = state.kind === "running";

  // Color theme flips green on success. While idle/running/error we stay
  // amber — distinct from the green "everything's fine" state of healthy
  // agents above the banner.
  const containerClass = isSuccess
    ? "border-emerald-500/30 bg-emerald-500/5"
    : "border-amber-500/25 bg-amber-500/4";

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${containerClass}`}
    >
      <div className="flex items-start gap-3">
        {isSuccess ? (
          <CheckCircle2 className="size-4 text-emerald-300 shrink-0 mt-0.5" />
        ) : (
          <AlertCircle className="size-4 text-amber-300/80 shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div
            className={`text-xs font-medium ${
              isSuccess ? "text-emerald-200/90" : "text-amber-200/90"
            }`}
          >
            {isSuccess
              ? "Provisioning succeeded"
              : isRunning
                ? "Reprovisioning…"
                : "Provisioning incomplete"}
          </div>

          <ReprovisionStatusBody agent={agent} state={state} />
        </div>

        <button
          type="button"
          onClick={handleReprovision}
          disabled={isRunning || isSuccess}
          className="shrink-0 flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 text-xs text-white/85 transition hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? (
            <Loader2 className="size-3 animate-spin" />
          ) : isSuccess ? (
            <Check className="size-3 text-emerald-300" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {isRunning ? "Working…" : isSuccess ? "Done" : "Reprovision"}
        </button>
      </div>
    </div>
  );
}

// Body content of the reprovision panel — extracted so the banner header
// + button stay readable. Renders the right copy for each state and
// hides stale data when it'd be misleading (e.g. while running, the
// original DB error is no longer the latest signal so we drop it).
function ReprovisionStatusBody({
  agent,
  state,
}: {
  agent: AgentDTO;
  state:
    | { kind: "idle" }
    | { kind: "running"; step: string }
    | { kind: "success" }
    | { kind: "error"; message: string };
}) {
  if (state.kind === "running") {
    return <div className="mt-1 text-[11px] text-white/65">{state.step}</div>;
  }
  if (state.kind === "success") {
    return (
      <div className="mt-1 text-[11px] text-emerald-200/70">
        Refreshing agent state…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <>
        <div className="mt-1 text-[11px] text-white/55">
          Retry didn&apos;t go through. The original setup error is below — try
          again, or reset the kickoff if the gateway is still rate-limited.
        </div>
        <div className="mt-1.5 text-[11px] text-red-300/85 font-mono wrap-break-word">
          {state.message}
        </div>
      </>
    );
  }
  // idle
  return (
    <>
      <div className="mt-1 text-[11px] text-white/55">
        {agent.provisioningState === "failed"
          ? "Gateway rejected the initial setup. Retry to push this agent again."
          : "This agent never finished setup on the gateway. Retry to provision it."}
      </div>
      {agent.provisioningError && (
        <div className="mt-1.5 text-[11px] text-red-300/70 font-mono wrap-break-word">
          {agent.provisioningError}
        </div>
      )}
    </>
  );
}

// Per-agent on-chain anchor CTA, surfaced inside the Overview tab when
// a non-CEO ready agent is missing its on-chain registration. Reuses the
// batch hook with a single agent id — the hook handles the
// `pending.length === 1` branch with one signTransaction call. Parent
// keys this on agent.id so switching agents resets the hook state
// instead of leaking prepRef across selections.
//
// Prepare runs only on the user's Sign click (not on mount) — Solana
// blockhashes have ~60s lifetime; auto-preparing earlier and waiting for
// the click would race the expiry. Once prepare resolves to
// `ready-to-sign` the effect chains signAndRegister immediately so the
// wallet popup appears without an extra round-trip.
function AnchorAgentPanel({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const { stage, error, prepare, signAndRegister, reset } =
    useBatchAnchorAgents();
  const walletStatus = useAnchorWallet();

  const handleAnchor = useCallback(() => {
    if (walletStatus.kind !== "ready") return;
    if (stage !== "idle") return;
    void prepare({ companyId: agent.companyId, agentIds: [agent.id] });
  }, [walletStatus, stage, prepare, agent.companyId, agent.id]);

  // Chain prepare → sign automatically once prepare resolves.
  useEffect(() => {
    if (stage !== "ready-to-sign") return;
    if (walletStatus.kind !== "ready") return;
    void signAndRegister({
      companyId: agent.companyId,
      wallet: walletStatus.wallet,
    });
  }, [stage, walletStatus, signAndRegister, agent.companyId]);

  // Reload me on completion so the parent re-renders with
  // agentChainTxSignature populated; that drops `needsAnchor` to false
  // and unmounts this panel.
  useEffect(() => {
    if (stage !== "complete") return;
    void onReloadMe();
  }, [stage, onReloadMe]);

  const busy =
    stage === "preparing" ||
    stage === "awaiting-signature" ||
    stage === "deriving-keypairs" ||
    stage === "registering";

  const busyLabel =
    stage === "preparing"
      ? "Reserving on-chain slot…"
      : stage === "awaiting-signature"
        ? "Waiting for wallet signature…"
        : stage === "deriving-keypairs"
          ? "Deriving keypair…"
          : stage === "registering"
            ? "Submitting on-chain tx…"
            : null;

  const prettified = error ? prettifyAnchorError(error.code) : null;

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
            One signature derives an on-chain keypair and registers this agent
            in a single combined transaction. Your private key never leaves your
            wallet.
          </div>
        </div>
      </div>

      {error && prettified && (
        <div className="rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2.5 space-y-1.5">
          <div className="flex items-start gap-2">
            <p className="text-[11px] text-rose-200/95 leading-snug flex-1 min-w-0">
              {prettified.headline}
            </p>
            <span className="font-mono text-[10px] text-rose-300/80 bg-rose-500/15 px-1.5 py-0.5 rounded shrink-0">
              {error.code}
            </span>
          </div>
          <p className="text-[11px] text-white/65 leading-relaxed">
            {prettified.hint}
          </p>
        </div>
      )}

      {walletStatus.kind !== "ready" && walletStatus.kind !== "loading" && (
        <div className="text-[11px] text-amber-300/85 bg-amber-500/10 rounded-md px-2.5 py-1.5">
          {walletStatus.kind === "no-wallet"
            ? "Connect a Solana wallet to anchor this agent."
            : "Connected wallet doesn't match your OCCA identity. Reconnect with the original wallet."}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {error ? (
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold text-white transition-all"
            style={{
              background: "linear-gradient(150deg, #0ea5e9 0%, #0369a1 100%)",
            }}
          >
            <RefreshCw className="size-3.5" />
            Retry
          </button>
        ) : (
          <button
            type="button"
            onClick={handleAnchor}
            disabled={busy || walletStatus.kind !== "ready"}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background:
                !busy && walletStatus.kind === "ready"
                  ? "linear-gradient(150deg, #0ea5e9 0%, #0369a1 100%)"
                  : "rgba(255,255,255,0.08)",
            }}
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {busyLabel}
              </>
            ) : (
              <>
                <Link2 className="size-3.5" />
                Anchor on Solana
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// CEO anchor — 3-phase chain (company → identity → deployment), 3 wallet
// signatures total. Anchoring CEO implicitly creates the CompanyAccount
// PDA on chain (Phase A), then registers the portable AgentIdentity PDA
// (Phase B), then binds it to the company via Deployment PDA (Phase C).
//
// Wallet popups must originate from a user gesture per phase — Privy's
// embedded wallet silently no-ops if `signTransaction` is invoked from
// an effect chain. So each phase advances on a button click.
//
// Surfaces here (vs onboarding) because the live onboarding flow no
// longer anchors CEO automatically. Without this panel a freshly
// onboarded CEO has no path to chain registration — and `set_receiving_address`
// (Wallet tab) would stay disabled forever.
function AnchorCeoPanel({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const anchor = useAnchorIdentity();
  const walletStatus = useAnchorWallet();

  // Per-phase progression — each click reads the latest stage and
  // advances exactly one step. `useAnchorIdentity` enforces idempotency
  // server-side (already-registered short-circuits to the next phase).
  const onSignClick = useCallback(async () => {
    if (walletStatus.kind !== "ready") return;
    const stage = anchor.stage;

    if (stage === "idle" || stage === "registering-company") {
      await anchor.registerCompany({
        companyId: agent.companyId,
        wallet: walletStatus.wallet,
      });
      return;
    }
    if (
      stage === "ready-to-sign-identity" ||
      stage === "registering-identity"
    ) {
      await anchor.registerIdentity({
        identityId: agent.identityId,
        wallet: walletStatus.wallet,
      });
      return;
    }
    if (
      stage === "ready-to-sign" ||
      stage === "awaiting-signature" ||
      stage === "registering-agent"
    ) {
      await anchor.signAndRegisterAgent({
        agentId: agent.id,
        wallet: walletStatus.wallet,
      });
      return;
    }
  }, [anchor, walletStatus, agent.companyId, agent.identityId, agent.id]);

  // Reload me on completion so agentChainTxSignature populates and this
  // panel unmounts (needsAnchor flips to false in the parent).
  useEffect(() => {
    if (anchor.stage !== "complete") return;
    void onReloadMe();
  }, [anchor.stage, onReloadMe]);

  const busy =
    anchor.stage === "registering-company" ||
    anchor.stage === "registering-identity" ||
    anchor.stage === "awaiting-signature" ||
    anchor.stage === "registering-agent";

  // Step labels match the 3 phases the user signs through.
  const STEPS = [
    { key: "company", label: "Register company" },
    { key: "identity", label: "Register identity" },
    { key: "deployment", label: "Register deployment" },
  ] as const;

  // Map hook stage → step key for progress rendering.
  const activeStepIdx = (() => {
    switch (anchor.stage) {
      case "idle":
      case "registering-company":
        return 0;
      case "ready-to-sign-identity":
      case "registering-identity":
        return 1;
      case "ready-to-sign":
      case "awaiting-signature":
      case "registering-agent":
        return 2;
      case "complete":
        return 3;
    }
  })();

  const buttonLabel = (() => {
    if (busy) {
      switch (anchor.stage) {
        case "registering-company":
          return "Registering company…";
        case "registering-identity":
          return "Registering identity…";
        case "awaiting-signature":
        case "registering-agent":
          return "Registering deployment…";
        default:
          return "Working…";
      }
    }
    if (anchor.stage === "complete") return "Done";
    if (anchor.stage === "ready-to-sign-identity") return "Sign identity";
    if (anchor.stage === "ready-to-sign") return "Sign deployment";
    return "Sign company";
  })();

  const prettified = anchor.error
    ? prettifyAnchorError(anchor.error.code)
    : null;

  return (
    <Alert
      variant="warning"
      title="Action required: anchor company + CEO on Solana"
    >
      <p>
        Three signatures register the company, your identity, and the CEO
        deployment on-chain. The Wallet tab stays read-only until this
        completes. Your private key never leaves your wallet.
      </p>

      <div className="flex items-center gap-2 mt-3">
        {STEPS.map((s, idx) => {
          const done = idx < activeStepIdx;
          const active = idx === activeStepIdx && !done;
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <span
                className={`size-1.5 rounded-full ${
                  done
                    ? "bg-emerald-400"
                    : active
                      ? "bg-amber-300"
                      : "bg-white/20"
                }`}
              />
              <span
                className={
                  done
                    ? "text-[10.5px] text-emerald-300/80"
                    : active
                      ? "text-[10.5px] text-amber-100/90"
                      : "text-[10.5px] text-white/35"
                }
              >
                {s.label}
              </span>
              {idx < STEPS.length - 1 && (
                <span className="text-white/15 mx-0.5">/</span>
              )}
            </div>
          );
        })}
      </div>

      {anchor.error && prettified && (
        <div className="mt-3">
          <Alert
            variant="error"
            title={prettified.headline}
          >
            <p>{prettified.hint}</p>
            <p className="font-mono text-[10px] mt-1 opacity-70">
              {anchor.error.code}
            </p>
          </Alert>
        </div>
      )}

      {walletStatus.kind !== "ready" && walletStatus.kind !== "loading" && (
        <p className="mt-3 text-[11px]">
          {walletStatus.kind === "no-wallet"
            ? "Connect a Solana wallet to anchor."
            : "Connected wallet doesn't match your OCCA identity. Reconnect with the original wallet."}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 mt-3">
        {anchor.error ? (
          <Button variant="warning" size="md" onClick={anchor.reset}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        ) : (
          <Button
            variant="warning"
            size="md"
            onClick={onSignClick}
            disabled={busy || walletStatus.kind !== "ready"}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Link2 className="size-3.5" />
            )}
            {buttonLabel}
          </Button>
        )}
      </div>
    </Alert>
  );
}

// Map the SSE step keys the server emits ("creating_record",
// "provisioning", "gateway_restart", "seeding_workspace",
// "assigning_skills") to a short human label. Falls back to the raw key
// so a future step lands gracefully instead of erroring.
function prettyStep(step: string): string {
  switch (step) {
    case "creating_record":
      return "Updating record…";
    case "provisioning":
      return "Provisioning on gateway…";
    case "gateway_restart":
      return "Waiting for gateway restart…";
    case "seeding_workspace":
      return "Seeding workspace…";
    case "assigning_skills":
      return "Assigning skills…";
    default:
      return step.replace(/_/g, " ") + "…";
  }
}
