"use client";

// Agent status visuals — a leaf primitive so any feature can render the
// same connection/activity dot + pill without reaching into features/agents
// (cross-feature imports are forbidden). Pure: depends only on AgentDTO
// fields from @occa/shared.

import type { AgentDTO } from "@occa/shared/types";

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
