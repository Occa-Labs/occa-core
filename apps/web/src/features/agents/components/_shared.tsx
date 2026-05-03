"use client";

// Pure helpers + small visual primitives shared across the agent-window
// sub-components. Lives in `_shared` so the underscore signals "not a
// resource component" — readers know the file isn't another tab.

import type { AgentDTO, SkillDTO } from "@occa/shared/types";

export function roleAllows(skill: SkillDTO, role: string): boolean {
  return (
    skill.allowedRoles.length === 0 ||
    skill.allowedRoles.includes(role as SkillDTO["allowedRoles"][number])
  );
}

export interface StatusVisual {
  dotClass: string;
  pulse: boolean;
  label: string;
  pillClass: string;
}

export function deriveStatusVisual(agent: AgentDTO): StatusVisual {
  // Connection trumps activity for the dot color — a disconnected agent
  // can't be "working" in any meaningful sense. For activity, surface
  // working/error first since those are what users watch for.
  if (agent.connectionState === "disconnected") {
    return {
      dotClass: "bg-red-500",
      pulse: false,
      label: "Disconnected",
      pillClass: "bg-red-500/15 text-red-300 border-red-400/30",
    };
  }
  if (agent.connectionState === "unknown") {
    return {
      dotClass: "bg-white/30",
      pulse: false,
      label: "Connecting…",
      pillClass: "bg-white/8 text-white/60 border-white/15",
    };
  }
  if (agent.activityState === "working") {
    return {
      dotClass: "bg-sky-400",
      pulse: true,
      label: "Working",
      pillClass: "bg-sky-500/15 text-sky-200 border-sky-400/30",
    };
  }
  if (agent.activityState === "error") {
    return {
      dotClass: "bg-red-400",
      pulse: false,
      label: "Last run failed",
      pillClass: "bg-red-500/15 text-red-300 border-red-400/30",
    };
  }
  if (agent.activityState === "cooldown") {
    return {
      dotClass: "bg-amber-400",
      pulse: false,
      label: "Cooldown",
      pillClass: "bg-amber-500/15 text-amber-200 border-amber-400/30",
    };
  }
  return {
    dotClass: "bg-emerald-400",
    pulse: false,
    label: "Idle",
    pillClass: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  };
}

export function StatusDot({
  agent,
  size = 8,
}: {
  agent: AgentDTO;
  size?: number;
}) {
  const v = deriveStatusVisual(agent);
  return (
    <span
      title={v.label}
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      {v.pulse && (
        <span
          className={`absolute inset-0 rounded-full ${v.dotClass} opacity-60 animate-ping`}
        />
      )}
      <span
        className={`relative inline-block rounded-full ${v.dotClass}`}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

export function StatusPill({ agent }: { agent: AgentDTO }) {
  const v = deriveStatusVisual(agent);
  const detail =
    agent.connectionState === "disconnected" && agent.connectionError
      ? `${v.label} — ${agent.connectionError}`
      : v.label;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${v.pillClass}`}
      title={
        agent.connectionCheckedAt
          ? `checked ${new Date(agent.connectionCheckedAt).toLocaleTimeString()}`
          : undefined
      }
    >
      <span className={`inline-block size-1.5 rounded-full ${v.dotClass}`} />
      {detail}
    </span>
  );
}

export function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
) {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return `${Math.round(diffMs / 86_400_000)}d ago`;
}

// Re-export the canonical role catalog from @occa/shared. This was inline
// here historically; the inline copy drifted from the backend. The shared
// package is now the single source of truth — see role-catalog.ts.
export {
  ROLE_ORDER,
  ROLE_CATALOG,
  CSUITE_ROLES,
  roleLabelFor,
} from "@occa/shared/role-catalog";

import { ROLE_CATALOG } from "@occa/shared/role-catalog";

// Map of slug → display label, derived from ROLE_CATALOG. Local re-shape
// kept for the autocomplete component which expects a plain Record.
export const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  ROLE_CATALOG.map((r) => [r.key, r.label]),
);
