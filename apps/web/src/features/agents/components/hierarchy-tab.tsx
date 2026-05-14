"use client";

// Visual org-chart for the current company. Read-only — clicking a node
// selects that agent in the parent AgentsWindow (same as clicking the
// sidebar). Source data is the same flat `agents` array; we build the
// tree client-side via parentAgentId links.
//
// Heads bold + emerald, specialists default text + slight indent. Pause
// state surfaced via tag chip next to name. Orphans (active agents
// pointing at a parent that's no longer here) bubble to a separate
// "Unparented" bucket so they don't disappear from the view.

import { useMemo } from "react";
import { ChevronRight, Pause } from "lucide-react";
import { formatRoleLabel } from "@/lib/format-role";
import type { AgentDTO } from "@occa/shared/types";
import { CEO_ROLE, getTier } from "@occa/shared/role-catalog";

export interface TreeNode {
  agent: AgentDTO;
  children: TreeNode[];
}

export function buildTree(agents: AgentDTO[]): {
  roots: TreeNode[];
  orphans: TreeNode[];
} {
  const byId = new Map<string, AgentDTO>();
  for (const a of agents) byId.set(a.id, a);

  const nodeById = new Map<string, TreeNode>();
  for (const a of agents) nodeById.set(a.id, { agent: a, children: [] });

  const roots: TreeNode[] = [];
  const orphans: TreeNode[] = [];
  for (const a of agents) {
    const node = nodeById.get(a.id)!;
    if (a.role === CEO_ROLE) {
      roots.push(node);
      continue;
    }
    if (a.parentAgentId && byId.has(a.parentAgentId)) {
      const parent = nodeById.get(a.parentAgentId)!;
      parent.children.push(node);
    } else if (a.parentAgentId == null) {
      // Top-level non-CEO. Surface as orphan so the user notices.
      orphans.push(node);
    } else {
      // Parent id set but no row found (data drift). Orphan bucket.
      orphans.push(node);
    }
  }

  // Stable sort within a level: heads first, then direct reports,
  // specialists, others. Matches the delegation-priority ordering in
  // the LLM-facing prompt.
  function sortChildren(n: TreeNode) {
    n.children.sort((a, b) => {
      const ta = tierRank(a.agent.role);
      const tb = tierRank(b.agent.role);
      if (ta !== tb) return ta - tb;
      return a.agent.name.localeCompare(b.agent.name);
    });
    n.children.forEach(sortChildren);
  }
  for (const r of roots) sortChildren(r);

  return { roots, orphans };
}

function tierRank(role: string): number {
  const tier = getTier(role) ?? "specialist";
  switch (tier) {
    case "ceo":
      return 0;
    case "head":
      return 1;
    case "direct_report":
      return 2;
    case "specialist":
      return 3;
    default:
      return 4;
  }
}

export function HierarchyTab({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentDTO[];
  selectedId: string | null;
  onSelect: (agentId: string) => void;
}) {
  const { roots, orphans } = useMemo(() => buildTree(agents), [agents]);

  return (
    <div className="px-5 py-5 space-y-5 text-white/85">
      <section>
        <h3 className="text-xs font-semibold text-white/55 uppercase tracking-wider mb-3">
          Org chart
        </h3>
        {roots.length === 0 ? (
          <p className="text-[12px] text-white/45">
            No CEO deployed yet — the chart appears once a top-level role
            lands.
          </p>
        ) : (
          <div className="space-y-1">
            {roots.map((r) => (
              <TreeRow
                key={r.agent.id}
                node={r}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </section>

      {orphans.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-amber-300/80 uppercase tracking-wider mb-3">
            Unparented
          </h3>
          <p className="text-[11px] text-white/45 mb-2 leading-relaxed">
            Active agents with no resolvable parent. Set a parent via the
            agent&apos;s Settings tab to slot them into the tree.
          </p>
          <div className="space-y-1">
            {orphans.map((o) => (
              <TreeRow
                key={o.agent.id}
                node={o}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
}) {
  const { agent, children } = node;
  const tier = getTier(agent.role) ?? "specialist";
  const isHead = tier === "head" || tier === "ceo";
  const isSelected = selectedId === agent.id;
  const isPaused = agent.status === "paused";

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(agent.id)}
        className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
          isSelected
            ? "bg-white/12 text-white"
            : "hover:bg-white/6 text-white/85"
        }`}
        style={{ paddingLeft: `${depth * 18 + 10}px` }}
      >
        {depth > 0 && (
          <ChevronRight className="size-3 text-white/30 shrink-0" />
        )}
        <span
          className={`text-[13px] truncate ${
            isHead ? "font-semibold text-emerald-200/90" : ""
          } ${isPaused ? "opacity-50" : ""}`}
        >
          {agent.name}
        </span>
        <span className="text-[11px] text-white/40 truncate">
          {formatRoleLabel(agent.role)}
        </span>
        {isPaused && (
          <span className="flex items-center gap-1 ml-auto shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-200/85 ring-1 ring-inset ring-amber-500/22">
            <Pause className="size-2.5" />
            paused
          </span>
        )}
      </button>
      {children.length > 0 && (
        <div className="space-y-0.5">
          {children.map((c) => (
            <TreeRow
              key={c.agent.id}
              node={c}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
