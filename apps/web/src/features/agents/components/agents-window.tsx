"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Loader2,
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
import { IS_PRODUCTION_MODE, UNLOCK_PRODUCTION } from "@/lib/env-flags";
import type { AgentDTO } from "@occa/shared/types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { initial, ROLE_ORDER, StatusDot, StatusPill } from "./_shared";
import { OverviewTab } from "./overview-tab";
import { SkillsTab } from "./skills-tab";
import { ToolsTab } from "./tools-tab";
import { ActivityTab } from "./activity-tab";
import { FilesTab } from "./files-tab";
import { TracesTab } from "./traces-tab";
import { DeployAgentModal } from "./deploy-agent-modal";
import { ChannelsSection } from "./channels-section";
import { buildTree, type TreeNode } from "./hierarchy-tab";

interface AgentsWindowProps {
  companyId: string;
  companyName: string;
  agents: AgentDTO[];
  /** The user's idle agents (owned, not in any company). Sourced from the
   *  raw owner-scoped /api/me list — NOT the company roster — and surfaced
   *  in the "Add existing" picker so they can be assigned into this company. */
  idleAgents: AgentDTO[];
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
  | "chain"
  | "skills"
  | "tools"
  | "activity"
  | "traces"
  | "files"
  | "settings";

// Activity + Traces surfaces are WIP — kept visible (so the IA stays
// honest) but disabled on a stock production build. The unlocked
// operator instance (NEXT_PUBLIC_UNLOCK_PRODUCTION=1) gets them. Same
// for the Chat button below.
//
// Hierarchy view lives in the sidebar (toggle), not as a per-agent tab —
// it's an org-wide navigation surface, not a per-agent detail.
const FEATURE_LOCKED = IS_PRODUCTION_MODE && !UNLOCK_PRODUCTION;

const TABS: { id: TabId; label: string; disabled?: boolean }[] = [
  { id: "overview", label: "Overview" },
  { id: "skills", label: "Skills" },
  { id: "tools", label: "Tools" },
  { id: "activity", label: "Activity", disabled: FEATURE_LOCKED },
  { id: "traces", label: "Traces", disabled: FEATURE_LOCKED },
  { id: "files", label: "Files" },
  { id: "settings", label: "Settings" },
];

export function AgentsWindow({
  companyId,
  companyName,
  agents,
  idleAgents,
  onReloadMe,
  initialAgentId = null,
  onClose,
}: AgentsWindowProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialAgentId);
  const [deployOpen, setDeployOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  // `agents` is already the company roster (the OS passes the company-scoped
  // list). `idleAgents` arrives separately for the "Add existing" picker.
  const companyAgents = agents;

  // External re-selection: theater click on a different agent updates
  // initialAgentId. We force-sync selectedId so the new agent surfaces
  // even when the window is already open.
  useEffect(() => {
    if (initialAgentId) setSelectedId(initialAgentId);
  }, [initialAgentId]);

  useEffect(() => {
    if (!selectedId && companyAgents.length > 0) {
      setSelectedId(companyAgents[0].id);
      return;
    }
    if (selectedId && !companyAgents.find((a) => a.id === selectedId)) {
      setSelectedId(companyAgents[0]?.id ?? null);
    }
  }, [companyAgents, selectedId]);

  const selected = useMemo(
    () => companyAgents.find((a) => a.id === selectedId) ?? null,
    [companyAgents, selectedId],
  );

  const handleDeployed = useCallback(
    async (newAgentId: string) => {
      setDeployOpen(false);
      await onReloadMe();
      setSelectedId(newAgentId);
    },
    [onReloadMe],
  );

  const handleAssigned = useCallback(
    async (assignedAgentId: string) => {
      setAssignOpen(false);
      await onReloadMe();
      setSelectedId(assignedAgentId);
    },
    [onReloadMe],
  );

  return (
    <>
      <AppWindow
        title="Agents"
        subtitle={`${companyAgents.length} agent${companyAgents.length !== 1 ? "s" : ""}`}
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
            agents={companyAgents}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDeploy={() => setDeployOpen(true)}
            idleCount={idleAgents.length}
            onAddExisting={() => setAssignOpen(true)}
          />
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {selected ? (
              <AgentDetail
                agent={selected}
                agents={companyAgents}
                onReloadMe={onReloadMe}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-white/50">
                  {companyAgents.length === 0
                    ? "No agents yet"
                    : "Select an agent"}
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
        agents={companyAgents}
        companyId={companyId}
      />
      <AssignExistingModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        companyId={companyId}
        companyName={companyName}
        idleAgents={idleAgents}
        onAssigned={handleAssigned}
      />
    </>
  );
}

// ── Add-existing picker ────────────────────────────────────────────────────
// Lists the user's idle agents (owned, not in any company) and assigns the
// chosen one into this company. Server fills in index/parent/seat — no
// re-provision, since an idle agent is already running on its gateway.
function AssignExistingModal({
  open,
  onClose,
  companyId,
  companyName,
  idleAgents,
  onAssigned,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companyName: string;
  idleAgents: AgentDTO[];
  onAssigned: (agentId: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assign = useCallback(
    async (agentId: string) => {
      setBusyId(agentId);
      setError(null);
      try {
        await agentsApi.assignToCompany(agentId, { companyId });
        onAssigned(agentId);
      } catch (e) {
        setError(
          e instanceof ApiError
            ? `Couldn't add agent (${e.status})`
            : "Couldn't add agent",
        );
        setBusyId(null);
      }
    },
    [companyId, onAssigned],
  );

  return (
    <Modal open={open} onClose={onClose} title="Add existing agent">
      <div className="px-5 py-4 space-y-3">
        <p className="text-xs text-white/50">
          Idle agents you own. Adding one places it in {companyName} under its
          canonical manager.
        </p>
        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        {idleAgents.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-white/30">
            No idle agents available.
          </div>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {idleAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                disabled={busyId !== null}
                onClick={() => assign(agent.id)}
                className="w-full text-left flex items-center gap-3 rounded-xl px-3 py-2.5 bg-white/5 hover:bg-white/10 border border-white/8 transition-colors cursor-pointer disabled:opacity-50"
              >
                <div className="size-8 rounded-full bg-white/8 text-white/70 flex items-center justify-center text-xs font-semibold shrink-0">
                  {initial(agent.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-white/85 truncate">
                    {agent.name}
                  </div>
                  <div className="text-[10px] text-white/40 truncate">
                    {formatRoleLabel(agent.role)}
                  </div>
                </div>
                {busyId === agent.id && (
                  <Loader2 className="size-4 text-white/50 animate-spin shrink-0" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function AgentSidebar({
  companyName,
  agents,
  selectedId,
  onSelect,
  onDeploy,
  idleCount,
  onAddExisting,
}: {
  companyName: string;
  agents: AgentDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeploy: () => void;
  idleCount: number;
  onAddExisting: () => void;
}) {
  const [query, setQuery] = useState("");
  // Default to tree so the org structure is visible at a glance.
  // List view stays available for quick role-grouped lookup.
  const [view, setView] = useState<"tree" | "list">("tree");

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

  // Tree always uses the unfiltered agents — preserves the hierarchy so
  // a child match doesn't orphan its parent. Visual highlight could be
  // added later; for now search is list-only.
  const tree = useMemo(() => buildTree(agents), [agents]);

  return (
    <div className="w-60 shrink-0 flex flex-col border-r border-white/8">
      <div className="px-4 py-3 border-b border-white/8 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Company
        </div>
        <div className="text-sm font-medium text-white/80 truncate">
          {companyName}
        </div>
        {/* View toggle */}
        <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
          <button
            type="button"
            onClick={() => setView("tree")}
            className={`flex-1 rounded-md py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              view === "tree"
                ? "bg-white/12 text-white"
                : "text-white/55 hover:text-white/80"
            }`}
          >
            Tree
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            className={`flex-1 rounded-md py-1 text-[11px] font-medium transition-colors cursor-pointer ${
              view === "list"
                ? "bg-white/12 text-white"
                : "text-white/55 hover:text-white/80"
            }`}
          >
            List
          </button>
        </div>
        {view === "list" && (
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-white/30" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents…"
              className="w-full bg-white/5 rounded-lg pl-7 pr-2 py-1.5 text-xs text-white/80 placeholder:text-white/25 outline-none focus:ring-1 focus:ring-white/20"
            />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {view === "tree" ? (
          <SidebarTree
            tree={tree}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ) : (
          <>
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
          </>
        )}
      </div>

      {/* Deploy / add buttons */}
      <div className="shrink-0 p-3 border-t border-white/8 space-y-2">
        <button
          onClick={onDeploy}
          className="w-full flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium text-white/60 hover:text-white transition-all duration-150 cursor-pointer"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <Plus className="size-3.5" />
          Deploy agent
        </button>
        {idleCount > 0 && (
          <button
            onClick={onAddExisting}
            className="w-full flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium text-white/45 hover:text-white/80 transition-all duration-150 cursor-pointer"
          >
            Add existing agent ({idleCount})
          </button>
        )}
      </div>
    </div>
  );
}

// Compact tree view rendered in the sidebar. Mirrors the detail-panel
// HierarchyTab layout but uses tighter padding + smaller indent so it
// fits the 240px sidebar column. Click any node → selects that agent.
// File-explorer-style connector lines run between parent and child via
// absolutely-positioned guide bars on each row.
//
// Each row carries an `ancestorsHasMore` mask — one boolean per ancestor
// depth. true = that ancestor still has siblings below it in the tree,
// so a vertical pipe is drawn through this row in that column. false =
// the ancestor was its parent's last child, so no pipe (subtree ended).
function SidebarTree({
  tree,
  selectedId,
  onSelect,
}: {
  tree: { roots: TreeNode[]; orphans: TreeNode[] };
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (tree.roots.length === 0 && tree.orphans.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-white/30">
        No agents yet
      </div>
    );
  }
  const renderGroup = (nodes: TreeNode[]) =>
    nodes.map((n, i) => (
      <SidebarTreeRow
        key={n.agent.id}
        node={n}
        ancestorsHasMore={[]}
        isLastChild={i === nodes.length - 1}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    ));
  return (
    <div className="px-1 py-1 space-y-2">
      {tree.roots.length > 0 && <div>{renderGroup(tree.roots)}</div>}
      {tree.orphans.length > 0 && (
        <div>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-amber-300/70 font-semibold">
            Unparented
          </div>
          {renderGroup(tree.orphans)}
        </div>
      )}
    </div>
  );
}

// Column geometry — must stay in sync. INDENT_PX is the width each
// depth level consumes (where the connector line lives); ROW_MIN_PX
// is the row's min-height (drives where the elbow's horizontal stub
// lands vertically).
const TREE_INDENT_PX = 14;
const TREE_ROW_MIN_PX = 32;

function SidebarTreeRow({
  node,
  ancestorsHasMore,
  isLastChild,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  // One entry per ancestor — true = ancestor at that depth has more
  // siblings, draw a continuing pipe through this row in that column.
  ancestorsHasMore: boolean[];
  // Is this row its parent's last child? Decides whether the elbow's
  // own vertical extends past mid-row (continues to next sibling) or
  // stops at mid-row (subtree ends here).
  isLastChild: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { agent, children } = node;
  const depth = ancestorsHasMore.length;
  const isHead = agent.role === "ceo" || agent.role.startsWith("head_");
  const isSelected = selectedId === agent.id;
  const isPaused = agent.status === "paused";
  return (
    <div>
      <div
        className={`relative flex items-center transition-colors cursor-pointer rounded-md ${
          isSelected ? "bg-white/12" : "hover:bg-white/5"
        }`}
        style={{ minHeight: TREE_ROW_MIN_PX }}
        onClick={() => onSelect(agent.id)}
      >
        {/* Pass-through pipes from ancestors that still have more
            siblings below. Drawn only when `ancestorsHasMore[i]` is
            true so the line ends cleanly at the last child of each
            subtree. */}
        {ancestorsHasMore.map((hasMore, i) =>
          hasMore ? (
            <span
              key={i}
              className="absolute top-0 bottom-0 w-px bg-white/14"
              style={{ left: i * TREE_INDENT_PX + TREE_INDENT_PX / 2 }}
            />
          ) : null,
        )}
        {/* Elbow for THIS row's parent column. Top-to-middle vertical
            + middle horizontal stub forms the L. If this row isn't the
            last child, the vertical continues past mid-row so the next
            sibling row connects naturally. */}
        {depth > 0 && (
          <>
            <span
              className="absolute top-0 w-px bg-white/14"
              style={{
                left: (depth - 1) * TREE_INDENT_PX + TREE_INDENT_PX / 2,
                height: TREE_ROW_MIN_PX / 2,
              }}
            />
            <span
              className="absolute h-px bg-white/14"
              style={{
                left: (depth - 1) * TREE_INDENT_PX + TREE_INDENT_PX / 2,
                top: TREE_ROW_MIN_PX / 2,
                width: TREE_INDENT_PX / 2,
              }}
            />
            {!isLastChild && (
              <span
                className="absolute bottom-0 w-px bg-white/14"
                style={{
                  left: (depth - 1) * TREE_INDENT_PX + TREE_INDENT_PX / 2,
                  top: TREE_ROW_MIN_PX / 2,
                }}
              />
            )}
          </>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(agent.id);
          }}
          className="relative flex items-center gap-1.5 py-1 pr-2 text-left flex-1 min-w-0 cursor-pointer"
          style={{ paddingLeft: depth * TREE_INDENT_PX + 10 }}
        >
          <div className="flex flex-col min-w-0 flex-1">
            {/* Name + inline status dot. Dot is sized down (6px) and
                sits on the name baseline so it visually belongs to the
                name row instead of floating between the two text lines.
                Same indicator the list-view avatar shows. */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={`text-[11.5px] font-medium truncate ${
                  isSelected ? "text-white" : "text-white/85"
                } ${isHead ? "text-emerald-200/90" : ""} ${
                  isPaused ? "opacity-50" : ""
                }`}
              >
                {agent.name}
              </span>
              <StatusDot agent={agent} size={6} />
            </div>
            <span className="text-[9.5px] text-white/40 truncate">
              {formatRoleLabel(agent.role)}
            </span>
          </div>
          {isPaused && (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0 text-[9px] font-medium text-amber-200/85 ring-1 ring-inset ring-amber-500/22">
              paused
            </span>
          )}
        </button>
      </div>
      {children.length > 0 && (
        <div>
          {children.map((c, i) => (
            <SidebarTreeRow
              key={c.agent.id}
              node={c}
              // Append this row's "has more siblings" flag for descendants
              ancestorsHasMore={[...ancestorsHasMore, !isLastChild]}
              isLastChild={i === children.length - 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

export function AgentDetail({
  agent,
  agents,
  onReloadMe,
  companyLabel,
  hideSeating,
  chainTabSlot,
}: {
  agent: AgentDTO;
  agents: AgentDTO[];
  onReloadMe: () => Promise<void> | void;
  /** Passed through to OverviewTab — shows a "Company" row (home view).
   *  Omit inside the company OS where the company is implicit. */
  companyLabel?: string | null;
  /** Hide 3D-office Seat + Character rows (home view). */
  hideSeating?: boolean;
  /** Per-agent on-chain panel (anchor, receiving wallet, marketplace
   *  listing). Injected at app level so the agents feature stays free of
   *  chain imports. When provided, a "Chain" tab appears. */
  chainTabSlot?: ReactNode;
}) {
  const [tab, setTab] = useState<TabId>("overview");
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
          {(chainTabSlot
            ? [
                TABS[0],
                { id: "chain" as TabId, label: "Chain" },
                ...TABS.slice(1),
              ]
            : TABS
          ).map((t) => (
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
            <OverviewTab
              agent={agent}
              agents={agents}
              onReloadMe={onReloadMe}
              companyLabel={companyLabel}
              hideSeating={hideSeating}
            />
          </div>
        ) : tab === "chain" ? (
          <div className="h-full overflow-y-auto">{chainTabSlot}</div>
        ) : tab === "skills" ? (
          <div className="h-full overflow-y-auto">
            <SkillsTab agent={agent} onReloadMe={onReloadMe} />
          </div>
        ) : tab === "tools" ? (
          <div className="h-full overflow-y-auto">
            <ToolsTab agent={agent} onReloadMe={onReloadMe} />
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
              agents={agents}
              canRetire={isLifecycleControllable}
              onOpenRetire={() => setRetireModalOpen(true)}
              onReloadMe={onReloadMe}
            />
          </div>
        ) : (
          <TracesTab agentId={agent.id} tracesState={tracesState} />
        )}
      </div>

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
// pushed deep into a "Danger zone" section. Also hosts the "Reports to"
// reassign control, which moves the agent under a different parent.
function SettingsTab({
  agent,
  agents,
  canRetire,
  onOpenRetire,
  onReloadMe,
}: {
  agent: AgentDTO;
  agents: AgentDTO[];
  canRetire: boolean;
  onOpenRetire: () => void;
  onReloadMe: () => Promise<void> | void;
}) {
  const isCeo = agent.role === CEO_ROLE;

  // Eligible parents: any active agent in the same company that isn't
  // self AND isn't a descendant of self (server validates cycle too,
  // but the picker pre-filters by role tier — specialists can't manage
  // anyone). For minimum UX we just exclude self + self's descendants
  // by walking the tree; the server enforces hard rules.
  const descendantIds = useMemo(() => {
    const desc = new Set<string>();
    const childrenByParent = new Map<string, AgentDTO[]>();
    for (const a of agents) {
      if (!a.parentAgentId) continue;
      const arr = childrenByParent.get(a.parentAgentId) ?? [];
      arr.push(a);
      childrenByParent.set(a.parentAgentId, arr);
    }
    const queue: string[] = [agent.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const kids = childrenByParent.get(id) ?? [];
      for (const k of kids) {
        if (desc.has(k.id)) continue;
        desc.add(k.id);
        queue.push(k.id);
      }
    }
    return desc;
  }, [agent.id, agents]);

  const eligibleParents = agents.filter(
    (a) => a.id !== agent.id && a.status === "active" && !descendantIds.has(a.id),
  );

  const currentParent = agents.find((a) => a.id === agent.parentAgentId);
  const [parentDraft, setParentDraft] = useState<string>(
    agent.parentAgentId ?? "",
  );
  const [parentSaving, setParentSaving] = useState(false);
  const [parentError, setParentError] = useState<string | null>(null);

  useEffect(() => {
    setParentDraft(agent.parentAgentId ?? "");
  }, [agent.parentAgentId, agent.id]);

  const parentDirty = parentDraft !== (agent.parentAgentId ?? "");

  const onSaveParent = useCallback(async () => {
    if (!parentDirty || parentSaving) return;
    setParentSaving(true);
    setParentError(null);
    try {
      await agentsApi.patch(agent.id, {
        parentAgentId: parentDraft === "" ? null : parentDraft,
      });
      await onReloadMe();
    } catch (err) {
      setParentError(
        err instanceof ApiError &&
          err.body &&
          typeof err.body === "object" &&
          "error" in err.body
          ? String((err.body as Record<string, unknown>).error)
          : err instanceof Error
            ? err.message
            : "Failed to update parent",
      );
    } finally {
      setParentSaving(false);
    }
  }, [agent.id, parentDraft, parentDirty, parentSaving, onReloadMe]);

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

      {!isCeo && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-white/55 uppercase tracking-wider">
            Reports to
          </h3>
          <p className="text-[12px] text-white/55">
            Currently:{" "}
            <span className="text-white/85 font-medium">
              {currentParent ? currentParent.name : "—"}
            </span>
            {currentParent && (
              <span className="text-white/40">
                {" "}
                ({formatRoleLabel(currentParent.role)})
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <select
              value={parentDraft}
              onChange={(e) => setParentDraft(e.target.value)}
              disabled={parentSaving}
              className="flex-1 rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2 text-[13px] text-white/85 transition disabled:opacity-50 cursor-pointer appearance-none"
            >
              <option value="">— Top-level (no parent) —</option>
              {eligibleParents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({formatRoleLabel(p.role)})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onSaveParent}
              disabled={!parentDirty || parentSaving}
              className="px-3 py-2 rounded-lg text-[12px] font-semibold text-white transition-all disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
              style={{
                background:
                  parentDirty && !parentSaving
                    ? "linear-gradient(150deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.10) 100%)"
                    : "rgba(255,255,255,0.06)",
              }}
            >
              {parentSaving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                "Save"
              )}
            </button>
          </div>
          {parentError && (
            <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
              <AlertTriangle className="size-3.5 shrink-0" />
              {parentError}
            </div>
          )}
        </section>
      )}

      {agent.adapterType === "hermes" && (
        <HermesAdapterSection
          agent={agent}
          onReloadMe={onReloadMe}
        />
      )}

      {isCeo && <ChannelsSection agent={agent} />}

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

// Hermes-only adapter section in Settings. Rotate-bearer for the
// runtime's API key without re-deploying the agent. Backend probes the
// new bearer against the current gatewayUrl before persisting — the FE
// trusts that and just surfaces the success / failure.
function HermesAdapterSection({
  agent,
  onReloadMe,
}: {
  agent: AgentDTO;
  onReloadMe: () => Promise<void> | void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <>
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-white/55 uppercase tracking-wider">
          Runtime adapter
        </h3>
        <p className="text-[12px] text-white/55">
          {agent.name} runs on a Hermes HTTP gateway. Rotate the API
          bearer when the runtime operator issues a new one — the new
          key is probed against the existing gateway URL before the
          rotation commits, so a bad key won&apos;t replace the working
          one.
        </p>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-white/8 hover:bg-white/12 px-3 py-1.5 text-xs font-medium text-white/80 hover:text-white transition-colors cursor-pointer"
        >
          Rotate bearer
        </button>
      </section>
      <RotateBearerModal
        open={modalOpen}
        agent={agent}
        onClose={() => setModalOpen(false)}
        onRotated={async () => {
          setModalOpen(false);
          await onReloadMe();
        }}
      />
    </>
  );
}

function RotateBearerModal({
  open,
  agent,
  onClose,
  onRotated,
}: {
  open: boolean;
  agent: AgentDTO;
  onClose: () => void;
  onRotated: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setApiKey("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const onSubmit = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await agentsApi.rotateBearer(agent.id, trimmed);
      await onRotated();
    } catch (err) {
      const code =
        err instanceof ApiError &&
        err.body &&
        typeof err.body === "object" &&
        "error" in err.body
          ? String((err.body as Record<string, unknown>).error)
          : null;
      const reason =
        err instanceof ApiError &&
        err.body &&
        typeof err.body === "object" &&
        "reason" in err.body
          ? String((err.body as Record<string, unknown>).reason)
          : null;
      if (code === "gateway_unreachable") {
        setError(
          `Couldn't reach the runtime with that bearer${reason ? ` (${reason})` : ""}. Double-check the key and try again.`,
        );
      } else if (code === "rotate_bearer_not_supported_for_adapter") {
        setError("This adapter doesn't support rotating the bearer.");
      } else if (code === "agent_not_configured") {
        setError("Agent has no runtime config yet.");
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to rotate bearer.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [agent.id, apiKey, submitting, onRotated]);

  const footer = (
    <div className="flex items-center justify-end gap-3 px-5 py-3.5">
      <button
        type="button"
        onClick={onClose}
        disabled={submitting}
        className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white/50 hover:text-white/80 transition-colors disabled:opacity-40 cursor-pointer"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={submitting || apiKey.trim().length === 0}
        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-all disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
        style={{
          background:
            submitting || apiKey.trim().length === 0
              ? "rgba(255,255,255,0.08)"
              : "linear-gradient(150deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.10) 100%)",
        }}
      >
        {submitting ? (
          <>
            <Loader2 className="size-3.5 animate-spin" /> Probing…
          </>
        ) : (
          "Probe & save"
        )}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Rotate bearer" footer={footer}>
      <div className="px-5 py-5 space-y-4">
        <p className="text-[12.5px] text-white/65 leading-relaxed">
          Paste the new bearer token issued by the Hermes runtime for{" "}
          <span className="text-white/90 font-medium">{agent.name}</span>.
          OCCA probes the current gateway with this key before
          overwriting the stored one — a bad token won&apos;t replace
          the working one.
        </p>
        <div className="space-y-2">
          <label className="block text-[11px] text-white/55">
            New bearer token
          </label>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="hex64…"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            className="w-full rounded-xl bg-white/5 ring-1 ring-inset ring-white/10 focus:ring-white/22 focus:outline-none px-3.5 py-2.5 text-[13px] text-white/90 placeholder:text-white/22 font-mono transition disabled:opacity-50"
          />
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-300 ring-1 ring-inset ring-red-500/18">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            <span className="leading-relaxed">{error}</span>
          </div>
        )}
      </div>
    </Modal>
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
