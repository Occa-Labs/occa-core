"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
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
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SwitchAdapterModal } from "./switch-adapter-modal";
import { formatWhen } from "./_shared";

export function OverviewTab({
  agent,
  agents,
  onReloadMe,
  companyLabel,
  hideSeating,
}: {
  agent: AgentDTO;
  agents: AgentDTO[];
  onReloadMe: () => Promise<void> | void;
  /** Where this agent works — company name, or null = idle. When provided
   *  (home view), a "Company" row is shown. Omit inside a company OS where
   *  the company is implicit. */
  companyLabel?: string | null;
  /** Hide the 3D-office Seat + Character rows. They only make sense inside
   *  a company's office, so the home view turns them off. */
  hideSeating?: boolean;
}) {
  const [seatModalOpen, setSeatModalOpen] = useState(false);
  const [switchModalOpen, setSwitchModalOpen] = useState(false);

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

  type Row = {
    label: string;
    value: string;
    badge?: { text: string; variant: "success" | "warning" };
  };
  const rows: Row[] = [
    { label: "Name", value: agent.name },
    { label: "Role", value: formatRoleLabel(agent.role) },
    ...(companyLabel !== undefined
      ? [
          {
            label: "Company",
            value: companyLabel ?? "Not assigned",
            badge: companyLabel
              ? { text: "Working", variant: "success" as const }
              : { text: "Available", variant: "warning" as const },
          },
        ]
      : []),
    { label: "Reports to", value: reportsToValue },
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

  return (
    <div className="p-5 space-y-1">
      {needsReprovision && (
        <div className="pb-4">
          <ReprovisionPanel agent={agent} onReloadMe={onReloadMe} />
        </div>
      )}
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[140px_1fr] gap-3 py-2 border-b border-white/6 last:border-0"
        >
          <div className="text-xs text-white/40">{r.label}</div>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-white/80 font-mono truncate">
              {r.value}
            </span>
            {r.badge && (
              <Badge variant={r.badge.variant}>{r.badge.text}</Badge>
            )}
          </div>
        </div>
      ))}
      <AdapterRow
        agent={agent}
        onChangeClick={() => setSwitchModalOpen(true)}
      />
      <SwitchAdapterModal
        open={switchModalOpen}
        agent={agent}
        onClose={() => setSwitchModalOpen(false)}
        onReloadMe={onReloadMe}
      />
      {!hideSeating && (
        <>
          <SeatRow agent={agent} onChangeClick={() => setSeatModalOpen(true)} />
          <CharacterRow agent={agent} onReloadMe={onReloadMe} />
          <SeatPickerModal
            open={seatModalOpen}
            agent={agent}
            agents={agents}
            onClose={() => setSeatModalOpen(false)}
            onReloadMe={onReloadMe}
          />
        </>
      )}
      {hideSeating && agent.companyId === null && !agent.availableForWork && (
        <div className="mt-4 rounded-2xl border border-white/8 bg-white/4 p-4">
          <p className="text-xs text-white/55">
            Not listed in the marketplace yet. Open the{" "}
            <span className="font-medium text-white/80">Chain</span> tab to
            anchor this agent on-chain and set a receiving wallet, then list it
            so other companies can invite it.
          </p>
        </div>
      )}
    </div>
  );
}

// Marketplace opt-in for an idle agent (home view). Listing requires the
// agent to be anchored on-chain — the server rejects otherwise.
// ── Seat row + picker modal ──────────────────────────────────────────────
//
// Surfaces the agent's current 3D office desk and lets the operator move
// them. Reserved zones (meeting / lobby / exec) ARE available — manual
// override bypasses the auto-assign skip rule. Desks already taken by
// another agent in the company are shown but disabled (the partial unique
// index on `(company_id, workstation_id)` would reject the PATCH anyway;
// disabling avoids a round-trip).

// ── Adapter row ──────────────────────────────────────────────────────────
//
// Shows the runtime backing this agent (openclaw / hermes) and a Change
// button that opens the SwitchAdapterModal. Always shown (unlike seating)
// — the runtime matters in every context.

function AdapterRow({
  agent,
  onChangeClick,
}: {
  agent: AgentDTO;
  onChangeClick: () => void;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-2 border-b border-white/6">
      <div className="text-xs text-white/40">Adapter</div>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-white/80 font-mono truncate">
          {agent.adapterType}
        </span>
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
