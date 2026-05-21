"use client";

// Col 2 of the Chats window — counterparts the selected viewer has ever
// talked to, one row per (viewer, partner) pair. Multiple agent_dm
// threads with the same partner collapse into a single row; the row
// shows the latest activity across all of them. Clicking a row picks
// the partner for Col 3.
//
// Read-only listing. No mutation surface — initiating a new thread to
// an agent happens elsewhere (CEO chat, delegation marker, etc.).

import type { AgentDTO, InboxPartySummaryDTO } from "@occa/shared/types";
import { Star } from "lucide-react";
import { useInboxPartners } from "../api/use-inbox-partners";
import {
  type InboxParty,
  partiesEqual,
} from "../types";

interface PartnersColumnProps {
  viewer: InboxParty;
  viewerLabel: string;
  agents: AgentDTO[];
  selectedPartner: InboxParty | null;
  onSelectPartner: (p: InboxParty) => void;
}

export function PartnersColumn({
  viewer,
  viewerLabel,
  agents,
  selectedPartner,
  onSelectPartner,
}: PartnersColumnProps) {
  const { partners, loading, error } = useInboxPartners(viewer);

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-white/8 bg-black/10">
      <div className="border-b border-white/8 px-3 py-2.5">
        <h3 className="truncate text-xs font-semibold text-white/85">
          {viewerLabel}&apos;s chats
        </h3>
      </div>

      <ul className="flex-1 overflow-y-auto">
        {loading && partners.length === 0 && (
          <li className="px-3 py-4 text-center text-[11px] text-white/35">
            Loading…
          </li>
        )}
        {!loading && !error && partners.length === 0 && (
          <li className="px-3 py-6 text-center text-[11px] text-white/35">
            No conversations yet
          </li>
        )}
        {error && (
          <li className="px-3 py-4 text-center text-[11px] text-red-300/70">
            {error}
          </li>
        )}
        {partners.map((p) => {
          const party = partyFromSummary(p);
          const active = selectedPartner
            ? partiesEqual(party, selectedPartner)
            : false;
          const label = resolvePartyLabel(party, agents);
          return (
            <li key={`${p.kind}:${p.id}`}>
              <PartnerRow
                summary={p}
                label={label}
                active={active}
                onClick={() => onSelectPartner(party)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function partyFromSummary(s: InboxPartySummaryDTO): InboxParty {
  if (s.kind === "user") return { kind: "user" };
  return { kind: "deployment", deploymentId: s.id };
}

function resolvePartyLabel(p: InboxParty, agents: AgentDTO[]): string {
  if (p.kind === "user") return "You";
  return agents.find((a) => a.id === p.deploymentId)?.name ?? "Unknown agent";
}

function PartnerRow({
  summary,
  label,
  active,
  onClick,
}: {
  summary: InboxPartySummaryDTO;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const isUser = summary.kind === "user";
  const preview = formatPreview(summary.lastMessagePreview);
  const ago = formatRelativeShort(summary.lastMessageAt);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
        active
          ? "bg-white/12"
          : "hover:bg-white/6"
      }`}
    >
      <span
        className={`relative flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
          isUser
            ? "bg-amber-400/15 text-amber-200"
            : "bg-white/10 text-white/85"
        }`}
      >
        {isUser ? <Star className="size-4" /> : initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium text-white">
            {label}
          </span>
          <span className="shrink-0 text-[10px] text-white/40">{ago}</span>
        </span>
        <span className="mt-0.5 flex items-baseline justify-between gap-2">
          <span className="truncate text-[11px] text-white/55">{preview}</span>
          {summary.threadCount > 1 && (
            <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px text-[9px] font-medium text-white/65">
              {summary.threadCount}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function formatPreview(s: string): string {
  // Strip markdown headers / collapse whitespace so the preview is
  // a tidy single line. Truncation is handled by CSS (truncate).
  const flat = s.replace(/\s+/g, " ").trim();
  // Drop a leading "# Title" so directive messages don't preview as the
  // title — directive bodies live on the next line.
  const stripped = flat.replace(/^#{1,6}\s+\S+\s+/, "");
  return stripped || flat || "(empty)";
}

function formatRelativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
