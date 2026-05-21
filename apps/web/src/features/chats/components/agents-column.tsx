"use client";

// Col 1 of the Chats window — a flat roster of every agent in the
// company plus a pinned "★ You" row at the top. Selecting a row picks
// the viewer-perspective for the rest of the window (Cols 2 + 3 show
// that party's conversations). Read-only; deploy / retire flows live
// in the Agents window.

import { useMemo, useState } from "react";
import { Search, Star } from "lucide-react";
import type { AgentDTO } from "@occa/shared/types";
import { ROLE_ORDER } from "@occa/shared/role-catalog";
import { type InboxParty, partiesEqual } from "../types";

interface AgentsColumnProps {
  agents: AgentDTO[];
  selected: InboxParty;
  onSelect: (p: InboxParty) => void;
}

const USER_PARTY: InboxParty = { kind: "user" };

export function AgentsColumn({
  agents,
  selected,
  onSelect,
}: AgentsColumnProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q),
    );
  }, [agents, query]);

  const sorted = useMemo(() => {
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
    <div className="flex h-full w-56 shrink-0 flex-col border-r border-white/8 bg-black/20">
      <div className="border-b border-white/8 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents"
            className="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-2 text-xs text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
          />
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto py-1">
        <li>
          <Row
            label="You"
            sublabel="Owner"
            isUser
            active={selected.kind === "user"}
            onClick={() => onSelect(USER_PARTY)}
          />
        </li>
        {sorted.length > 0 && (
          <li>
            <div className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wider text-white/35">
              Agents
            </div>
          </li>
        )}
        {sorted.map((a) => {
          const party: InboxParty = { kind: "deployment", deploymentId: a.id };
          const active = partiesEqual(party, selected);
          return (
            <li key={a.id}>
              <Row
                label={a.name}
                sublabel={a.role}
                active={active}
                onClick={() => onSelect(party)}
              />
            </li>
          );
        })}
        {sorted.length === 0 && query && (
          <li className="px-3 py-2 text-xs text-white/40">
            No agents match &quot;{query}&quot;
          </li>
        )}
      </ul>
    </div>
  );
}

function Row({
  label,
  sublabel,
  active,
  isUser = false,
  onClick,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  isUser?: boolean;
  onClick: () => void;
}) {
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors ${
        active
          ? "bg-white/12 text-white"
          : "text-white/80 hover:bg-white/6 hover:text-white"
      }`}
    >
      <span
        className={`relative flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
          isUser
            ? "bg-amber-400/15 text-amber-200"
            : "bg-white/10 text-white/80"
        }`}
      >
        {isUser ? <Star className="size-3.5" /> : initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{label}</span>
        <span className="block truncate text-[10px] text-white/45">
          {sublabel}
        </span>
      </span>
    </button>
  );
}
