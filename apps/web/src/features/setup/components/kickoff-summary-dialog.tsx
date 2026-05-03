"use client";

import { useCallback, useState } from "react";
import { AlertCircle, Check, Loader2, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { AgentDTO } from "@occa/shared/types";
import { CEO_ROLE } from "@occa/shared/role-catalog";
import { agentsApi, ApiError } from "@/lib/api";
import { formatRoleLabel } from "@/lib/format-role";

interface KickoffSummaryDialogProps {
  agents: AgentDTO[];
  /** Refresh `me` so a successful retry's new state lands here. */
  onAgentReady: () => Promise<void> | void;
  /** "Enter your office" CTA — flips the workflow to phase=`live`. */
  onContinue: () => void;
}

// Final post-kickoff screen. Lists every hire (excluding the CEO, who
// existed before kickoff) with its provisioning state — ready, failed,
// or still pending. Failed hires can be retried via the existing
// reprovision endpoint without leaving the flow. Mounts only on the
// in-session edge `kickoffState=provisioning → completed` (see
// useSetupWorkflow); refreshing past it skips straight to `live`.
export function KickoffSummaryDialog({
  agents,
  onAgentReady,
  onContinue,
}: KickoffSummaryDialogProps) {
  const hires = agents.filter((a) => a.role !== CEO_ROLE);
  const ready = hires.filter((a) => a.provisioningState === "ready").length;
  const failedCount = hires.filter(
    (a) => a.provisioningState === "failed",
  ).length;

  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});

  const handleRetry = useCallback(
    async (agentId: string) => {
      setRetrying((prev) => new Set(prev).add(agentId));
      setRetryErrors((prev) => {
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
      try {
        // Reprovision streams SSE step events; ignore intermediate frames
        // — we just need the terminal "done" or thrown error.
        await agentsApi.reprovisionStream(agentId, () => {});
        await onAgentReady();
      } catch (err) {
        const message =
          err instanceof ApiError
            ? typeof err.body === "object" &&
              err.body &&
              "error" in err.body
              ? String((err.body as Record<string, unknown>).error)
              : `api_${err.status}`
            : err instanceof Error
              ? err.message
              : "retry_failed";
        setRetryErrors((prev) => ({ ...prev, [agentId]: message }));
      } finally {
        setRetrying((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [onAgentReady],
  );

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <Card spotlight padding="lg" className="relative w-full max-w-md">
        <div className="space-y-4">
          <header>
            <h2 className="text-base font-semibold text-white">
              Team is ready
            </h2>
            <p className="mt-1 text-sm text-white/60">
              {ready} of {hires.length} hires provisioned
              {failedCount > 0 ? ` — ${failedCount} failed` : ""}.
            </p>
          </header>

          <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
            {hires.map((agent) => {
              const state = agent.provisioningState;
              const isRetrying = retrying.has(agent.id);
              const retryError = retryErrors[agent.id];
              return (
                <div
                  key={agent.id}
                  className="flex items-start gap-3 rounded-lg bg-white/5 px-3 py-2.5"
                >
                  <div className="size-8 shrink-0 rounded-full bg-white/10 flex items-center justify-center text-xs font-semibold text-white/70">
                    {agent.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white/90 truncate">
                      {agent.name}
                    </div>
                    <div className="text-xs text-white/45">
                      {formatRoleLabel(agent.role)}
                    </div>
                    {state === "failed" && agent.provisioningError && (
                      <div className="mt-1 text-[11px] text-red-300/80 line-clamp-2">
                        {agent.provisioningError}
                      </div>
                    )}
                    {retryError && (
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-red-300/80">
                        <AlertCircle className="size-3" />
                        {retryError}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 self-center">
                    {state === "ready" ? (
                      <Check className="size-4 text-emerald-400" />
                    ) : state === "failed" ? (
                      <button
                        type="button"
                        onClick={() => handleRetry(agent.id)}
                        disabled={isRetrying}
                        className="flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 text-xs text-white/80 transition hover:bg-white/10 disabled:opacity-50"
                      >
                        {isRetrying ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RotateCcw className="size-3" />
                        )}
                        Retry
                      </button>
                    ) : (
                      <Loader2 className="size-4 animate-spin text-white/40" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <Button block onClick={onContinue}>
            Enter your office
          </Button>
        </div>
      </Card>
    </div>
  );
}
