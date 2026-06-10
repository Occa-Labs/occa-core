"use client";

// Run cost — the token/cost a task actually spent, summed across every
// trace it ran (re-dispatches accumulate). Reads the per-task usage summary;
// renders nothing until at least one run reported usage, so hand-completed
// tasks and still-running first attempts stay clean. Sits beside the
// Deliverable Journey in the task detail.

import { useTaskUsage } from "../api/use-task-usage";

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function RunCost({ taskId }: { taskId: string }) {
  const { data } = useTaskUsage(taskId);
  if (!data || data.runs === 0) return null;

  return (
    <>
      <hr className="border-white/8" />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-white/45">
            Run cost
          </div>
          <div className="text-[10px] text-white/40">
            {data.runs} run{data.runs === 1 ? "" : "s"}
          </div>
        </div>
        <div className="text-sm text-white/80 tabular-nums">
          {dollars(data.costCents)}
        </div>
        <p className="text-[11px] text-white/40 tabular-nums">
          {compact(data.tokensIn)} in · {compact(data.tokensOut)} out ·{" "}
          {compact(data.cachedTokensIn)} cached
        </p>
      </div>
    </>
  );
}
