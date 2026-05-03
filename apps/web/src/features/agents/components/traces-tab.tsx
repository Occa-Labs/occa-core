"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Drawer } from "@/components/ui/drawer";
import { useAgentTraces, useTrace } from "@/hooks/use-traces";
import type { TraceDTO, TraceStatus } from "@occa/shared/types";
import { MAX_RETRY_ATTEMPTS, isRetryExhausted } from "@occa/shared/errors";
import {
  formatDuration,
  formatRelativeTime,
  formatWhen,
} from "./_shared";

const TRACE_STATUS_STYLE: Record<string, string> = {
  queued: "bg-white/10 text-white/70",
  running: "bg-emerald-500/20 text-emerald-300",
  succeeded: "bg-emerald-500/10 text-emerald-300/80",
  failed: "bg-red-500/15 text-red-300",
  cancelled: "bg-white/8 text-white/50",
  timed_out: "bg-amber-500/15 text-amber-200",
};

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

function RetryBanner({ trace }: { trace: TraceDTO }) {
  // Retry countdown: the next retry (if any) lives on a *different* trace row
  // with scheduled_at set; to surface it here we peek at this trace's own
  // failureRetryAttempt + status. The dispatcher stamps the current trace's
  // attempt counter from the wake payload, so attempt N queued means N-1 prior
  // failures exist.
  const attempt = trace.failureRetryAttempt ?? 0;
  if (trace.status === "queued" && trace.scheduledAt) {
    const ms = new Date(trace.scheduledAt).getTime() - Date.now();
    return (
      <div className="col-span-2 text-amber-300/80">
        Retry {attempt}/{MAX_RETRY_ATTEMPTS} in {formatCountdown(ms)}
        {trace.retryReason ? ` (${trace.retryReason})` : ""}
      </div>
    );
  }
  if (trace.status === "failed") {
    const exhausted = isRetryExhausted({
      errorCode: trace.errorCode,
      failureRetryAttempt: attempt,
    });
    if (exhausted) {
      return (
        <div className="col-span-2 text-red-300/80">Retries exhausted</div>
      );
    }
    return (
      <div className="col-span-2 text-amber-300/80">
        Transient failure — retry {attempt + 1}/{MAX_RETRY_ATTEMPTS} queued
      </div>
    );
  }
  if (attempt > 0) {
    return (
      <div className="col-span-2 text-white/45">
        Retry attempt {attempt}/{MAX_RETRY_ATTEMPTS}
        {trace.retryReason ? ` (${trace.retryReason})` : ""}
      </div>
    );
  }
  return null;
}

type InvocationSource =
  | "timer"
  | "assignment"
  | "on_demand"
  | "automation"
  | "chat"
  | "skill_sync";
const WAKE_SOURCES: InvocationSource[] = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
];

const TRACE_STATUS_FILTERS: TraceStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

export function TracesTab({
  agentId,
  tracesState,
}: {
  agentId: string;
  tracesState: ReturnType<typeof useAgentTraces>;
}) {
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<InvocationSource | "all">(
    "all",
  );
  const [statusFilter, setStatusFilter] = useState<TraceStatus | "all">("all");
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedTraceId(null);
  }, [agentId]);

  const filteredTraces = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tracesState.traces.filter((r) => {
      if (sourceFilter !== "all" && r.invocationSource !== sourceFilter)
        return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        const hay = [
          r.id,
          r.invocationSource,
          r.status,
          r.error ?? "",
          r.errorCode ?? "",
          r.livenessState ?? "",
          r.triggerDetail ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tracesState.traces, sourceFilter, statusFilter, search]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !tracesState.hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void tracesState.loadMore();
        }
      },
      { root, rootMargin: "240px" },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [tracesState.hasMore, tracesState.loadMore, tracesState.traces.length]);

  const filtersActive =
    sourceFilter !== "all" || statusFilter !== "all" || search.trim() !== "";

  return (
    <div className="relative h-full overflow-hidden">
      <div className="flex flex-col h-full">
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-center gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search className="size-3.5 text-white/35 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search traces"
              className="w-full pl-8 pr-3 py-1.5 text-[12px] rounded-lg bg-white/6 ring-1 ring-inset ring-white/10 focus:ring-white/25 focus:outline-none text-white/85 placeholder:text-white/35 transition"
            />
          </div>
          <FilterDropdown
            label="Source"
            value={sourceFilter}
            options={WAKE_SOURCES}
            onChange={setSourceFilter}
          />
          <FilterDropdown
            label="Status"
            value={statusFilter}
            options={TRACE_STATUS_FILTERS}
            onChange={setStatusFilter}
          />
          {filtersActive && (
            <button
              onClick={() => {
                setSourceFilter("all");
                setStatusFilter("all");
                setSearch("");
              }}
              className="text-[11px] text-white/55 hover:text-white/85 px-2 py-1 rounded-md hover:bg-white/6 transition"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 px-5 pb-4">
          {tracesState.loading && tracesState.traces.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-white/40">
              <Loader2 className="size-3.5 animate-spin mr-2" /> Loading traces…
            </div>
          ) : tracesState.error && tracesState.traces.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-red-300/80">
              <AlertCircle className="size-3.5 mr-2" /> {tracesState.error}
            </div>
          ) : tracesState.traces.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center space-y-2">
                <p className="text-sm text-white/55">No traces yet</p>
                <p className="text-xs text-white/35">
                  Assign this agent to a task to start.
                </p>
              </div>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="h-full overflow-y-auto rounded-2xl bg-white/3 ring-1 ring-inset ring-white/8"
            >
              <ul className="divide-y divide-white/6">
                {filteredTraces.map((trace) => (
                  <TraceListRow
                    key={trace.id}
                    trace={trace}
                    active={trace.id === selectedTraceId}
                    onSelect={() => setSelectedTraceId(trace.id)}
                  />
                ))}
              </ul>
              {filteredTraces.length === 0 && (
                <div className="py-10 text-center text-[12px] text-white/40">
                  No traces match the current filters.
                </div>
              )}
              {tracesState.hasMore ? (
                <div
                  ref={sentinelRef}
                  className="flex items-center justify-center py-4 text-[11px] text-white/40"
                >
                  {tracesState.loadingMore ? (
                    <>
                      <Loader2 className="size-3 animate-spin mr-1.5" /> Loading
                      more…
                    </>
                  ) : (
                    <span>Scroll for more</span>
                  )}
                </div>
              ) : (
                <div className="py-4 text-center text-[11px] text-white/30">
                  {filteredTraces.length === tracesState.traces.length
                    ? `${tracesState.traces.length} trace${tracesState.traces.length !== 1 ? "s" : ""}`
                    : `${filteredTraces.length} of ${tracesState.traces.length} trace${tracesState.traces.length !== 1 ? "s" : ""}`}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Drawer
        open={selectedTraceId !== null}
        onClose={() => setSelectedTraceId(null)}
        widthClassName="max-w-2xl"
      >
        {selectedTraceId ? (
          <TraceDetail
            traceId={selectedTraceId}
            onClose={() => setSelectedTraceId(null)}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

// Compact dropdown for trace filters. Shows just the label ("Source") when
// at default "all"; switches to "Source: Value" with a brighter tint when a
// concrete filter is applied, so the toolbar communicates active state at a
// glance.
function humanizeFilterValue(v: string): string {
  return v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function FilterDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | "all";
  options: readonly T[];
  onChange: (v: T | "all") => void;
}) {
  const active = value !== "all";
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T | "all")}
        className={`appearance-none rounded-md pl-3 pr-7 py-1.5 text-[12px] cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/25 transition-colors ${
          active
            ? "bg-white/12 text-white ring-1 ring-inset ring-white/15"
            : "bg-white/6 text-white/70 ring-1 ring-inset ring-white/10 hover:text-white/90"
        }`}
        aria-label={label}
      >
        <option value="all">{label}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {label}: {humanizeFilterValue(o)}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3 text-white/40" />
    </div>
  );
}

function TraceListRow({
  trace,
  active,
  onSelect,
}: {
  trace: TraceDTO;
  active: boolean;
  onSelect: () => void;
}) {
  const statusClass =
    TRACE_STATUS_STYLE[trace.status] ?? "bg-white/10 text-white/70";
  const tokens = trace.usage
    ? (trace.usage.tokensIn ?? 0) + (trace.usage.tokensOut ?? 0)
    : null;
  const when = new Date(trace.createdAt);
  return (
    <li>
      <button
        onClick={onSelect}
        className={`group w-full text-left flex items-center gap-4 px-4 py-3 transition-colors ${
          active ? "bg-white/9" : "hover:bg-white/5"
        }`}
      >
        <div className="min-w-40 shrink-0">
          <div className="text-[13px] font-medium text-white/90 tabular-nums">
            {when.toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            <span className="text-white/40">
              :{String(when.getSeconds()).padStart(2, "0")}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-white/50 capitalize">
            {trace.invocationSource.replace(/_/g, " ")}
            <span className="ml-2 text-white/30 normal-case">
              · {formatRelativeTime(trace.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium rounded-full px-2 py-0.5 ${statusClass}`}
          >
            {trace.status === "running" && (
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
            {trace.status}
          </span>
          {trace.livenessState && trace.livenessState !== "normal" && (
            <span className="text-[10px] text-white/45 italic">
              {trace.livenessState.replace(/_/g, " ")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4 text-[12px] tabular-nums text-white/60 shrink-0">
          <span className="min-w-13 text-right">
            {formatDuration(trace.startedAt, trace.finishedAt)}
          </span>
          <span className="min-w-12 text-right">
            {tokens !== null ? `${tokens} tok` : "—"}
          </span>
        </div>

        <ChevronRight className="size-3.5 shrink-0 text-white/25 group-hover:text-white/55 transition-colors" />
      </button>
    </li>
  );
}

function TraceDetail({
  traceId,
  onClose,
}: {
  traceId: string;
  onClose: () => void;
}) {
  const { trace, events, cancel } = useTrace(traceId);
  const logRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  const copyEvents = useCallback(async () => {
    if (events.length === 0) return;
    const text = events
      .map((e) => {
        const seq = String(e.seq).padStart(3, "0");
        const body = e.message ?? (e.payload ? JSON.stringify(e.payload) : "");
        return `[${seq}] ${e.eventType} ${body}`.trimEnd();
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; silently ignore
    }
  }, [events]);

  if (!trace) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-white/40">
        <Loader2 className="size-3.5 animate-spin mr-2" /> Loading trace…
      </div>
    );
  }

  const canCancel = trace.status === "queued" || trace.status === "running";

  const tokens = trace.usage
    ? (trace.usage.tokensIn ?? 0) + (trace.usage.tokensOut ?? 0)
    : null;
  const showDiagnostics =
    !!trace.error ||
    (trace.status === "queued" && !!trace.scheduledAt) ||
    trace.status === "failed" ||
    (trace.failureRetryAttempt ?? 0) > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-5 pt-4 pb-3 flex items-center gap-2">
        <button
          onClick={onClose}
          className="group/controls size-6 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
          aria-label="Close"
        >
          <X className="size-3 text-white/40 group-hover/controls:text-white/90" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-white/45">
              {trace.invocationSource.replace(/_/g, " ")}
            </span>
            <span className="text-[11px] text-white/25">·</span>
            <span className="text-[12px] font-mono text-white/70">
              {trace.id.slice(0, 8)}
            </span>
          </div>
        </div>
        {canCancel && (
          <button
            onClick={cancel}
            className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full bg-red-500/15 text-red-300 hover:bg-red-500/25 transition-colors"
          >
            <X className="size-3" /> Cancel
          </button>
        )}
      </div>

      <div className="shrink-0 px-5 pb-3 flex items-center gap-x-3 gap-y-1.5 flex-wrap text-[11px]">
        <span
          className={`inline-flex items-center gap-1.5 uppercase tracking-wide font-medium rounded-full px-2 py-0.5 ${
            TRACE_STATUS_STYLE[trace.status] ?? "bg-white/10"
          }`}
        >
          {trace.status === "running" && (
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
          )}
          {trace.status}
        </span>
        <span className="text-white/55">
          <span className="text-white/35 mr-1">Started</span>
          {trace.startedAt ? formatWhen(trace.startedAt) : "—"}
        </span>
        <span className="text-white/20">·</span>
        <span className="text-white/55 tabular-nums">
          <span className="text-white/35 mr-1">Duration</span>
          {formatDuration(trace.startedAt, trace.finishedAt)}
        </span>
        {tokens !== null && (
          <>
            <span className="text-white/20">·</span>
            <span className="text-white/55 tabular-nums">
              <span className="text-white/35 mr-1">Tokens</span>
              {tokens}
              <span className="text-white/30 ml-1">
                ({trace.usage!.tokensIn ?? 0}/{trace.usage!.tokensOut ?? 0})
              </span>
            </span>
          </>
        )}
        {trace.livenessState && trace.livenessState !== "normal" && (
          <>
            <span className="text-white/20">·</span>
            <span className="text-white/55 italic">
              {trace.livenessState.replace(/_/g, " ")}
            </span>
          </>
        )}
      </div>

      {showDiagnostics && (
        <div className="shrink-0 mx-5 mb-3 rounded-xl bg-white/5 ring-1 ring-inset ring-white/8 p-3 space-y-1.5 text-[11px]">
          {trace.error && (
            <div className="text-red-300/85 wrap-break-word">
              <span className="text-red-300/60 mr-1.5">Error</span>
              {trace.errorCode ? `${trace.errorCode} · ` : ""}
              {trace.error}
            </div>
          )}
          <RetryBanner trace={trace} />
        </div>
      )}

      <div className="flex-1 min-h-0 px-5 pb-5 flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col rounded-xl bg-black/35 ring-1 ring-inset ring-white/6 overflow-hidden">
          <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-white/6">
            <span className="text-[10px] uppercase tracking-wider text-white/40">
              Events
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white/35 tabular-nums">
                {events.length}
              </span>
              <button
                type="button"
                onClick={copyEvents}
                disabled={events.length === 0}
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded text-white/45 hover:text-white/80 hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/45 transition-colors"
                aria-label="Copy events"
              >
                {copied ? (
                  <>
                    <Check className="size-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" /> Copy
                  </>
                )}
              </button>
            </div>
          </div>
          <div
            ref={logRef}
            className="flex-1 min-h-0 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed"
          >
            {events.length === 0 ? (
              <div className="text-white/35">
                {trace.status === "queued"
                  ? "Waiting for worker…"
                  : "No events"}
              </div>
            ) : (
              events.map((e) => (
                <div
                  key={e.id}
                  className={`whitespace-pre-wrap wrap-break-word py-0.5 ${
                    e.level === "error"
                      ? "text-red-300/90"
                      : e.stream === "stderr"
                        ? "text-amber-200/90"
                        : "text-white/75"
                  }`}
                >
                  <span className="text-white/25 mr-2 tabular-nums">
                    [{String(e.seq).padStart(3, "0")}]
                  </span>
                  <span className="text-white/45 mr-2">{e.eventType}</span>
                  {e.message ?? (e.payload ? JSON.stringify(e.payload) : "")}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
