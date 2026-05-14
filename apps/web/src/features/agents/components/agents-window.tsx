"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { Modal } from "@/components/ui/modal";
import { useAgentTraces } from "@/hooks/use-traces";
import { useAgentActivity } from "@/features/agents/api/use-agent-activity";
import { formatRoleLabel } from "@/lib/format-role";
import { ApiError, agentsApi } from "@/lib/api";
import { IS_PRODUCTION_MODE } from "@/lib/env-flags";
import type { AgentDTO } from "@occa/shared/types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { initial, ROLE_ORDER, StatusDot, StatusPill } from "./_shared";
import { OverviewTab } from "./overview-tab";
import { SkillsTab } from "./skills-tab";
import { ActivityTab } from "./activity-tab";
import { FilesTab } from "./files-tab";
import { TracesTab } from "./traces-tab";
import { ChatModal } from "./chat-modal";
import { DeployAgentModal } from "./deploy-agent-modal";

interface AgentsWindowProps {
  companyName: string;
  agents: AgentDTO[];
  onReloadMe: () => Promise<void> | void;
  /** When set, seeds the selected agent on mount AND re-selects whenever
   *  the value changes (e.g. user clicks a different agent in the 3D
   *  office while the window is already open). Local sidebar clicks
   *  don't change this prop, so user-initiated selection still works. */
  initialAgentId?: string | null;
  onClose?: () => void;
}

type TabId =
  | "overview"
  | "skills"
  | "activity"
  | "traces"
  | "files"
  | "settings";

// Activity + Traces surfaces are WIP — kept visible (so the IA stays
// honest) but disabled in production preview mode. Same for the Chat
// button below. Re-enable everything by clearing
// NEXT_PUBLIC_PREVIEW_PRODUCTION in apps/web/.env.local.
const TABS: { id: TabId; label: string; disabled?: boolean }[] = [
  { id: "overview", label: "Overview" },
  { id: "skills", label: "Skills" },
  { id: "activity", label: "Activity", disabled: IS_PRODUCTION_MODE },
  { id: "traces", label: "Traces", disabled: IS_PRODUCTION_MODE },
  { id: "files", label: "Files" },
  { id: "settings", label: "Settings" },
];

export function AgentsWindow({
  companyName,
  agents,
  onReloadMe,
  initialAgentId = null,
  onClose,
}: AgentsWindowProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialAgentId);
  const [deployOpen, setDeployOpen] = useState(false);

  // External re-selection: theater click on a different agent updates
  // initialAgentId. We force-sync selectedId so the new agent surfaces
  // even when the window is already open.
  useEffect(() => {
    if (initialAgentId) setSelectedId(initialAgentId);
  }, [initialAgentId]);

  useEffect(() => {
    if (!selectedId && agents.length > 0) {
      setSelectedId(agents[0].id);
      return;
    }
    if (selectedId && !agents.find((a) => a.id === selectedId)) {
      setSelectedId(agents[0]?.id ?? null);
    }
  }, [agents, selectedId]);

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const handleDeployed = useCallback(
    async (newAgentId: string) => {
      setDeployOpen(false);
      await onReloadMe();
      setSelectedId(newAgentId);
    },
    [onReloadMe],
  );

  return (
    <>
      <AppWindow
        title="Agents"
        subtitle={`${agents.length} agent${agents.length !== 1 ? "s" : ""}`}
        onClose={onClose}
        defaultSize={{
          w: Math.min(1000, Math.round(window.innerWidth * 0.82)),
          h: Math.min(680, Math.round(window.innerHeight * 0.82)),
        }}
        minWidth={720}
        minHeight={440}
      >
        <div className="flex h-full overflow-hidden">
          <AgentSidebar
            companyName={companyName}
            agents={agents}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeploy={() => setDeployOpen(true)}
          />
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {selected ? (
              <AgentDetail
                agent={selected}
                agents={agents}
                onReloadMe={onReloadMe}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-white/50">
                  {agents.length === 0 ? "No agents yet" : "Select an agent"}
                </p>
              </div>
            )}
          </div>
        </div>
      </AppWindow>
      <DeployAgentModal
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        onDeployed={handleDeployed}
        agents={agents}
      />
    </>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function AgentSidebar({
  companyName,
  agents,
  selectedId,
  onSelect,
  onDeploy,
}: {
  companyName: string;
  agents: AgentDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeploy: () => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q),
    );
  }, [agents, query]);

  // Sort agents by canonical role order (CEO first, then C-suite, etc.).
  // Agents with the same role keep their original ordering. Section
  // headers were dropped — role is shown inline as each agent's subtitle
  // — so this is a flat list, not a grouped one.
  const sortedAgents = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.role);
      const bi = ROLE_ORDER.indexOf(b.role);
      if (ai === -1 && bi === -1) return a.role.localeCompare(b.role);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [filtered]);

  return (
    <div className="w-60 shrink-0 flex flex-col border-r border-white/8">
      <div className="px-4 py-3 border-b border-white/8 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Company
        </div>
        <div className="text-sm font-medium text-white/80 truncate">
          {companyName}
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="w-full bg-white/5 rounded-lg pl-7 pr-2 py-1.5 text-xs text-white/80 placeholder:text-white/25 outline-none focus:ring-1 focus:ring-white/20"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-white/30">
            {agents.length === 0 ? "No agents yet" : "No matches"}
          </div>
        )}
        {sortedAgents.map((agent) => {
          const active = agent.id === selectedId;
          return (
            <button
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              className={`relative w-full text-left flex items-center gap-2.5 px-3 py-2 transition-colors ${
                active ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-full bg-white/80" />
              )}
              <div
                className={`relative size-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                  active
                    ? "bg-white/15 text-white"
                    : "bg-white/8 text-white/70"
                }`}
              >
                {initial(agent.name)}
                <span className="absolute bottom-0 right-0">
                  <StatusDot agent={agent} size={8} />
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-xs font-medium truncate ${
                    active ? "text-white" : "text-white/80"
                  }`}
                >
                  {agent.name}
                </div>
                <div className="text-[10px] text-white/40 truncate">
                  {formatRoleLabel(agent.role)}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Deploy button */}
      <div className="shrink-0 p-3 border-t border-white/8">
        <button
          onClick={onDeploy}
          className="w-full flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium text-white/60 hover:text-white transition-all duration-150"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <Plus className="size-3.5" />
          Deploy agent
        </button>
      </div>
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function AgentDetail({
  agent,
  agents,
  onReloadMe,
}: {
  agent: AgentDTO;
  agents: AgentDTO[];
  onReloadMe: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<TabId>("overview");
  const [chatOpen, setChatOpen] = useState(false);
  const [retireModalOpen, setRetireModalOpen] = useState(false);
  const [statusTogglePending, setStatusTogglePending] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const tracesState = useAgentTraces(agent.id, tab === "traces");
  const activityState = useAgentActivity(agent.id, tab === "activity");

  // CEO is the keypair source-of-truth for the whole company (every other
  // agent borrows its deviceKeypair). Retiring CEO would orphan all deployments
  // — block it from the UI; user can wipe the company instead if they
  // really want to start over. Same gate covers pause (server enforces too).
  const isLifecycleControllable = agent.role !== CEO_ROLE;
  const isPaused = agent.status === "paused";

  const onTogglePauseResume = useCallback(async () => {
    if (statusTogglePending) return;
    setStatusTogglePending(true);
    setStatusError(null);
    try {
      if (isPaused) {
        await agentsApi.activate(agent.id);
      } else {
        await agentsApi.pause(agent.id);
      }
      await onReloadMe();
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : "Failed to toggle status",
      );
    } finally {
      setStatusTogglePending(false);
    }
  }, [agent.id, isPaused, onReloadMe, statusTogglePending]);

  return (
    <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-5 pt-4 pb-0 border-b border-white/8">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-base font-semibold text-white/90 truncate">
              {agent.name}
            </h2>
            <span className="text-xs font-medium text-white/45">
              {formatRoleLabel(agent.role)}
            </span>
            <StatusPill agent={agent} />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              disabled={IS_PRODUCTION_MODE}
              title={
                IS_PRODUCTION_MODE
                  ? "Chat is not available in production preview"
                  : undefined
              }
              className="flex items-center gap-1.5 rounded-md bg-white/8 hover:bg-white/12 px-3 py-1.5 text-xs font-medium text-white/80 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/8 disabled:hover:text-white/80"
            >
              <MessageSquare className="size-3" />
              Chat
            </button>
            {isLifecycleControllable && (
              <button
                type="button"
                onClick={onTogglePauseResume}
                disabled={statusTogglePending}
                className={
                  isPaused
                    ? "flex items-center gap-1.5 rounded-md bg-emerald-500/12 hover:bg-emerald-500/22 px-3 py-1.5 text-xs font-medium text-emerald-300/90 hover:text-emerald-200 transition-colors ring-1 ring-inset ring-emerald-500/22 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    : "flex items-center gap-1.5 rounded-md bg-amber-500/12 hover:bg-amber-500/22 px-3 py-1.5 text-xs font-medium text-amber-200/90 hover:text-amber-100 transition-colors ring-1 ring-inset ring-amber-500/22 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                }
                title={
                  isPaused
                    ? "Resume this agent — flip back to active"
                    : "Pause this agent — exclude from active team filters"
                }
              >
                {statusTogglePending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : isPaused ? (
                  <Play className="size-3" />
                ) : (
                  <Pause className="size-3" />
                )}
                {isPaused ? "Resume" : "Pause"}
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              disabled={t.disabled}
              title={t.disabled ? "Not available in production preview" : undefined}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:text-white/50 ${
                tab === t.id
                  ? "text-white bg-white/8"
                  : "text-white/50 hover:text-white/80"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {statusError && (
        <div className="mx-5 mt-2 flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
          <AlertTriangle className="size-3.5 shrink-0" />
          {statusError}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {tab === "overview" ? (
          <div className="h-full overflow-y-auto">
            <OverviewTab agent={agent} agents={agents} onReloadMe={onReloadMe} />
          </div>
        ) : tab === "skills" ? (
          <div className="h-full overflow-y-auto">
            <SkillsTab agent={agent} onReloadMe={onReloadMe} />
          </div>
        ) : tab === "activity" ? (
          <ActivityTab agentId={agent.id} activityState={activityState} />
        ) : tab === "files" ? (
          <div className="h-full overflow-y-auto">
            <FilesTab agentId={agent.id} />
          </div>
        ) : tab === "settings" ? (
          <div className="h-full overflow-y-auto">
            <SettingsTab
              agent={agent}
              canRetire={isLifecycleControllable}
              onOpenRetire={() => setRetireModalOpen(true)}
            />
          </div>
        ) : (
          <TracesTab agentId={agent.id} tracesState={tracesState} />
        )}
      </div>

      {chatOpen && (
        <ChatModal agent={agent} onClose={() => setChatOpen(false)} />
      )}
      <RetireAgentModal
        open={retireModalOpen}
        agent={agent}
        onClose={() => setRetireModalOpen(false)}
        onRetired={async () => {
          setRetireModalOpen(false);
          await onReloadMe();
        }}
      />
    </div>
  );
}

// Settings tab — destructive lifecycle actions (Retire) live here so
// the card header stays focused on the reversible toggle (Pause/Resume).
// Mirrors the pattern from settings panels where "delete account" is
// pushed deep into a "Danger zone" section.
function SettingsTab({
  agent,
  canRetire,
  onOpenRetire,
}: {
  agent: AgentDTO;
  canRetire: boolean;
  onOpenRetire: () => void;
}) {
  return (
    <div className="px-5 py-5 space-y-6">
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-white/55 uppercase tracking-wider">
          Lifecycle
        </h3>
        <p className="text-[12px] text-white/55">
          Pause/Resume sits in the header — toggle the agent in or out of
          your active team without losing identity, workspace, or history.
          Retiring is destructive and lives below.
        </p>
      </section>
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-red-300/80 uppercase tracking-wider">
          Danger zone
        </h3>
        {!canRetire ? (
          <p className="text-[12px] text-white/45">
            CEO can&apos;t be retired from here — every other agent borrows
            its keypair. Wipe the whole company instead if you want to
            start over.
          </p>
        ) : (
          <div className="rounded-lg ring-1 ring-inset ring-red-500/22 bg-red-500/5 p-4 space-y-3">
            <div className="space-y-1">
              <p className="text-[13px] font-medium text-white/85">
                Retire {agent.name}
              </p>
              <p className="text-[11.5px] text-white/55 leading-relaxed">
                Removes the agent from the gateway, wipes workspace files +
                skill installs, reassigns tasks, deletes traces + sessions.
                The on-chain work record stays (immutable). Not reversible
                — use Pause if you just need to take them off-rotation
                temporarily.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenRetire}
              className="flex items-center gap-1.5 rounded-md bg-red-500/12 hover:bg-red-500/22 px-3 py-1.5 text-xs font-medium text-red-300/90 hover:text-red-200 transition-colors ring-1 ring-inset ring-red-500/22 cursor-pointer"
            >
              <Trash2 className="size-3" />
              Retire agent
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// Confirmation modal for retiring an agent. Calls DELETE /api/agents/:id
// which deprovisions the gateway side (best-effort) + cascades local cleanup
// (tasks, tokens, runtime state, sessions, traces). Two-step confirm: user
// must type the agent's name to enable the destructive button — same
// pattern GitHub uses for repo deletion. Avoids accidental retirements.
// Naming follows CLAUDE.md regulatory guidance: use "retire" not "fire".
function RetireAgentModal({
  open,
  agent,
  onClose,
  onRetired,
}: {
  open: boolean;
  agent: AgentDTO;
  onClose: () => void;
  onRetired: () => Promise<void> | void;
}) {
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state on close so reopening lands on a clean form.
  useEffect(() => {
    if (open) return;
    setConfirm("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const canRetire = confirm.trim() === agent.name && !submitting;

  const handleRetire = useCallback(async () => {
    if (!canRetire) return;
    setSubmitting(true);
    setError(null);
    try {
      await agentsApi.remove(agent.id);
      await onRetired();
    } catch (err) {
      const code =
        err instanceof ApiError &&
        err.body &&
        typeof err.body === "object" &&
        "error" in err.body
          ? String((err.body as Record<string, unknown>).error)
          : null;
      setError(
        code ?? (err instanceof Error ? err.message : "Failed to retire agent."),
      );
      setSubmitting(false);
    }
  }, [agent.id, canRetire, onRetired]);

  const footer = (
    <div className="flex items-center justify-end gap-3 px-5 py-3.5">
      <button
        onClick={onClose}
        disabled={submitting}
        className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white/50 hover:text-white/80 transition-colors disabled:opacity-40 cursor-pointer"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={() => void handleRetire()}
        disabled={!canRetire}
        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-all disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
        style={{
          background: canRetire
            ? "linear-gradient(150deg, #dc2626 0%, #b91c1c 100%)"
            : "rgba(255,255,255,0.08)",
        }}
      >
        {submitting ? (
          <>
            <Loader2 className="size-3.5 animate-spin" /> Retiring…
          </>
        ) : (
          <>
            <Trash2 className="size-3.5" /> Retire agent
          </>
        )}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Retire agent" footer={footer}>
      <div className="px-5 py-5 space-y-4">
        <div className="flex items-start gap-3 rounded-lg bg-amber-500/10 p-3 ring-1 ring-inset ring-amber-500/22">
          <AlertTriangle className="size-4 text-amber-300/85 shrink-0 mt-0.5" />
          <div className="space-y-1.5 text-[12px] text-amber-100/85">
            <p className="font-medium">This is destructive.</p>
            <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-100/70">
              <li>Agent removed from OpenClaw gateway</li>
              <li>Workspace files + skill installs wiped</li>
              <li>Tasks reassigned, traces + sessions deleted</li>
              <li>Seat freed, tracked work-record stays on-chain (immutable)</li>
            </ul>
          </div>
        </div>
        <div className="space-y-2">
          <label className="block text-[11px] text-white/55">
            Type the agent&apos;s name to confirm:{" "}
            <span className="font-mono text-white/85">{agent.name}</span>
          </label>
          <input
            type="text"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={submitting}
            placeholder={agent.name}
            className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-red-500/40 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/85 placeholder:text-white/22 transition disabled:opacity-50 font-mono"
          />
        </div>
        {error && (
          <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
            <AlertTriangle className="size-3.5 shrink-0" />
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
