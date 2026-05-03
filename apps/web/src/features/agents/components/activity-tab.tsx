"use client";

import { useEffect, useRef } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MessageSquare,
  RefreshCw,
  Terminal,
  Zap,
} from "lucide-react";
import { useAgentActivity } from "@/features/agents/api/use-agent-activity";
import type { ActivityGroup } from "@occa/shared/types";
import { formatDuration, formatRelativeTime } from "./_shared";

const KIND_ICON: Record<ActivityGroup["kind"], React.ReactNode> = {
  chat: <MessageSquare className="size-3 shrink-0" />,
  task: <CheckCircle2 className="size-3 shrink-0" />,
  skill_sync: <Zap className="size-3 shrink-0" />,
  trace: <Terminal className="size-3 shrink-0" />,
};

const KIND_COLOR: Record<ActivityGroup["kind"], string> = {
  chat: "text-sky-300/70",
  task: "text-emerald-300/70",
  skill_sync: "text-amber-300/70",
  trace: "text-white/40",
};

const ACTIVITY_STATUS_STYLE: Record<string, string> = {
  queued: "bg-white/10 text-white/60",
  running: "bg-emerald-500/20 text-emerald-300",
  succeeded: "bg-emerald-500/10 text-emerald-300/75",
  failed: "bg-red-500/15 text-red-300",
  cancelled: "bg-white/8 text-white/40",
  timed_out: "bg-amber-500/15 text-amber-200",
};

export function ActivityTab({
  activityState,
}: {
  agentId: string;
  activityState: ReturnType<typeof useAgentActivity>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !activityState.hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting))
          void activityState.loadMore();
      },
      { root, rootMargin: "240px" },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [
    activityState.hasMore,
    activityState.loadMore,
    activityState.groups.length,
  ]);

  if (activityState.loading && activityState.groups.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-white/40">
        <Loader2 className="size-3.5 animate-spin mr-2" /> Loading activity…
      </div>
    );
  }

  if (activityState.error && activityState.groups.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-red-300/80">
        <AlertCircle className="size-3.5 mr-2" /> {activityState.error}
      </div>
    );
  }

  if (activityState.groups.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center">
        <Terminal className="size-5 text-white/15" />
        <p className="text-sm text-white/40">No activity yet</p>
        <p className="text-[11px] text-white/25">
          Chat, run tasks, or sync skills to see agent activity.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-5 pt-4 pb-2 flex items-center justify-between">
        <span className="text-[11px] text-white/35 uppercase tracking-wider">
          {activityState.groups.length} group
          {activityState.groups.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={() => void activityState.reload()}
          className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/65 transition-colors"
        >
          <RefreshCw className="size-3" />
          Refresh
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
        <div className="rounded-2xl bg-white/3 ring-1 ring-inset ring-white/8 divide-y divide-white/6">
          {activityState.groups.map((group) => (
            <ActivityGroupRow key={group.groupKey} group={group} />
          ))}
        </div>

        {activityState.hasMore ? (
          <div
            ref={sentinelRef}
            className="flex items-center justify-center py-4 text-[11px] text-white/40"
          >
            {activityState.loadingMore ? (
              <>
                <Loader2 className="size-3 animate-spin mr-1.5" /> Loading more…
              </>
            ) : (
              <span>Scroll for more</span>
            )}
          </div>
        ) : (
          <div className="py-3 text-center text-[11px] text-white/25">
            {activityState.groups.length} group
            {activityState.groups.length !== 1 ? "s" : ""} total
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityGroupRow({ group }: { group: ActivityGroup }) {
  const trace = group.latestTrace;
  const statusClass =
    ACTIVITY_STATUS_STYLE[trace.status] ?? "bg-white/10 text-white/60";
  const kindColor = KIND_COLOR[group.kind];

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Kind icon */}
      <div className={`shrink-0 ${kindColor}`}>{KIND_ICON[group.kind]}</div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-white/85 truncate">
            {group.label}
          </span>
          {group.traceCount > 1 && (
            <span className="shrink-0 text-[10px] text-white/30 tabular-nums">
              {group.traceCount}×
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/40">
          <span>{formatRelativeTime(group.lastActivityAt)}</span>
          <span className="text-white/20">·</span>
          <span className="capitalize">{group.kind.replace(/_/g, " ")}</span>
          {trace.startedAt && trace.finishedAt && (
            <>
              <span className="text-white/20">·</span>
              <span className="tabular-nums">
                {formatDuration(trace.startedAt, trace.finishedAt)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Status badge */}
      <span
        className={`shrink-0 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium rounded-full px-2 py-0.5 ${statusClass}`}
      >
        {trace.status === "running" && (
          <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
        )}
        {trace.status}
      </span>
    </div>
  );
}
