"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useToolLogs } from "@/features/tools/api/use-tools";

interface ToolLogsProps {
  companyId: string;
  toolId: string;
}

export function ToolLogs({ companyId, toolId }: ToolLogsProps) {
  const { logs, loading, error } = useToolLogs({
    companyId,
    toolId,
    limit: 20,
  });

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white/40 py-2">
        <Loader2 className="size-3.5 animate-spin" /> Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-xs text-red-300/80 py-2">
        Failed to load logs: {error}
      </div>
    );
  }
  if (logs.length === 0) {
    return (
      <div className="text-xs text-white/40 py-2">
        No invocations yet. The agent hasn't called this tool.
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {logs.map((log) => (
        <li
          key={log.id}
          className="flex items-start gap-2 rounded-md px-3 py-2 bg-white/3"
        >
          {log.status === "success" ? (
            <CheckCircle2 className="size-3.5 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <XCircle
              className={`size-3.5 shrink-0 mt-0.5 ${log.status === "rate_limited" ? "text-amber-400" : "text-red-400"}`}
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-mono text-white/85">
                {log.action}
              </span>
              {log.latencyMs !== null && (
                <span className="text-[10px] text-white/35">
                  {log.latencyMs}ms
                </span>
              )}
              <span className="text-[10px] text-white/35 ml-auto">
                {formatRelativeTime(log.createdAt)}
              </span>
            </div>
            {log.status !== "success" && log.errorMessage && (
              <p className="text-[11px] text-red-200/75 mt-0.5 truncate">
                {log.errorCode}: {log.errorMessage}
              </p>
            )}
            {log.resultSummary && log.status === "success" && (
              <ResultSummary summary={log.resultSummary} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ResultSummary({ summary }: { summary: Record<string, unknown> }) {
  const entries = Object.entries(summary).slice(0, 3);
  if (entries.length === 0) return null;
  return (
    <div className="text-[11px] text-white/45 mt-0.5 truncate">
      {entries
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" · ")}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const delta = Math.max(0, now - then);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
