"use client";

// Vertical timeline of `task_events` for one task. The append-only log
// drives this — every entry shown here is a row from `task_events`,
// projected through `eventLabel()` into a human-readable label + optional
// detail line. Workflow events (Phase 5+) will land here too once
// emitted as `agent_action_emitted` rows with `actionType: WorkflowExecuted`.

import type { TaskEventDTO } from "@occa/shared/types";

interface AgentRef {
  id: string;
  name: string;
}

export function TaskTimeline({
  events,
  agentList,
}: {
  events: TaskEventDTO[];
  agentList?: AgentRef[];
}) {
  if (events.length === 0) {
    return (
      <div className="text-xs text-white/30 py-2">No activity yet.</div>
    );
  }
  const agentName = (id: string | null | undefined): string => {
    if (!id) return "—";
    return agentList?.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  };
  return (
    <ol className="relative space-y-2.5 pl-4">
      <span
        aria-hidden
        className="absolute left-1 top-1 bottom-1 w-px bg-white/8"
      />
      {events.map((event) => {
        const { label, detail } = eventLabel(event, agentName);
        return (
          <li key={event.id} className="relative">
            <span
              aria-hidden
              className={`absolute -left-[15px] top-1.5 size-2 rounded-full ${dotColor(event.actorType)}`}
            />
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] text-white/30 font-mono shrink-0 w-12">
                {formatTime(event.createdAt)}
              </span>
              <span className="text-xs text-white/70">{label}</span>
            </div>
            {detail && (
              <p className="ml-14 text-[11px] text-white/40 mt-0.5">
                {detail}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function dotColor(actorType: TaskEventDTO["actorType"]): string {
  switch (actorType) {
    case "user":
      return "bg-white/60";
    case "agent":
      return "bg-blue-400";
    case "system":
      return "bg-white/25";
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function eventLabel(
  event: TaskEventDTO,
  agentName: (id: string | null | undefined) => string,
): { label: string; detail?: string } {
  const p = event.payload;
  switch (event.eventType) {
    case "task_created": {
      const title = typeof p.title === "string" ? p.title : null;
      const via = typeof p.via === "string" ? p.via : null;
      return {
        label:
          via === "delegate" || via === "EmitFollowUp"
            ? `Created via ${via}`
            : "Task created",
        detail: title ?? undefined,
      };
    }
    case "task_assigned": {
      const deploymentId =
        typeof p.deploymentId === "string" ? p.deploymentId : null;
      const previousId =
        typeof p.previousDeploymentId === "string"
          ? p.previousDeploymentId
          : null;
      if (!deploymentId) return { label: "Unassigned" };
      return {
        label: previousId
          ? `Reassigned to ${agentName(deploymentId)}`
          : `Assigned to ${agentName(deploymentId)}`,
      };
    }
    case "task_status_changed": {
      const from = typeof p.from === "string" ? p.from : "?";
      const to = typeof p.to === "string" ? p.to : "?";
      const reason = typeof p.reason === "string" ? p.reason : null;
      return {
        label: `Status: ${from} → ${to}`,
        detail: reason ?? undefined,
      };
    }
    case "agent_trace_started":
      return { label: "Agent run started" };
    case "agent_trace_finished": {
      const outcome = typeof p.outcome === "string" ? p.outcome : "finished";
      const error = typeof p.error === "string" ? p.error : null;
      return {
        label: `Agent run ${outcome}`,
        detail: error ?? undefined,
      };
    }
    case "agent_action_emitted": {
      const actionType =
        typeof p.actionType === "string" ? p.actionType : "action";
      const reason = typeof p.reason === "string" ? p.reason : null;
      const title = typeof p.title === "string" ? p.title : null;
      return {
        label: `Emitted ${actionType}`,
        detail: reason ?? title ?? undefined,
      };
    }
    case "comment_added": {
      const body = typeof p.body === "string" ? p.body : null;
      return {
        label: "Comment",
        detail: body ? truncate(body, 120) : undefined,
      };
    }
    case "task_blocked": {
      const ids = Array.isArray(p.blockedByTaskIds) ? p.blockedByTaskIds : [];
      const reason = typeof p.reason === "string" ? p.reason : null;
      return {
        label: `Blocked (waiting on ${ids.length} task${ids.length === 1 ? "" : "s"})`,
        detail: reason ?? undefined,
      };
    }
    case "task_unblocked": {
      const by = typeof p.by === "string" ? p.by : "cascade";
      return { label: `Unblocked (${by})` };
    }
    case "task_archived": {
      const reason = typeof p.reason === "string" ? p.reason : null;
      return { label: "Archived", detail: reason ?? undefined };
    }
    case "task_unarchived":
      return { label: "Unarchived" };
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}
