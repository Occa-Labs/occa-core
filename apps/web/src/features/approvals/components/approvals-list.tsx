"use client";

import { Bot, Loader2 } from "lucide-react";
import type { AgentDTO, ApprovalDTO } from "@occa/shared/types";
import { cn } from "@/lib/utils";
import { surface } from "@/components/ui/tokens";
import {
  approvalStatusLabel,
  humanizeApprovalAction,
  relativeTime,
} from "../utils";

interface ApprovalsListProps {
  approvals: ApprovalDTO[];
  agentById: Map<string, AgentDTO>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  emptyText?: string;
}

export function ApprovalsList({
  approvals,
  agentById,
  selectedId,
  onSelect,
  loading,
  emptyText = "No pending approvals.",
}: ApprovalsListProps) {
  if (loading && approvals.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-white/40">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (approvals.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-white/40">
        {emptyText}
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {approvals.map((a) => (
        <ApprovalRow
          key={a.id}
          approval={a}
          agentById={agentById}
          selected={a.id === selectedId}
          onClick={() => onSelect(a.id)}
        />
      ))}
    </ul>
  );
}

interface ApprovalRowProps {
  approval: ApprovalDTO;
  agentById: Map<string, AgentDTO>;
  selected: boolean;
  onClick: () => void;
}

function ApprovalRow({
  approval,
  agentById,
  selected,
  onClick,
}: ApprovalRowProps) {
  const agent = approval.requestedByAgentId
    ? agentById.get(approval.requestedByAgentId)
    : null;
  const agentName = agent?.name ?? "Agent";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeApprovalAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
          "border-b border-white/5",
          selected
            ? "bg-white/8 text-white"
            : "text-white/80 hover:bg-white/5 hover:text-white",
        )}
      >
        <div
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/70"
          style={surface.recessed}
        >
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[12px] font-semibold">
              {agentName}
            </span>
            {agentRole && (
              <span className="shrink-0 text-[10px] text-white/40">
                · {agentRole}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-white/40">
              {relativeTime(approval.requestedAt)}
            </span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-[11px] text-white/55">
            {actionLabel}
          </div>
          {approval.status !== "pending" && (
            <StatusChip status={approval.status} />
          )}
        </div>
      </button>
    </li>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "bg-emerald-500/12 text-emerald-300/90 ring-emerald-500/22"
      : status === "rejected"
        ? "bg-red-500/12 text-red-300/90 ring-red-500/22"
        : "bg-white/8 text-white/50 ring-white/15";
  return (
    <span
      className={cn(
        "mt-1 inline-flex rounded-full px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide ring-1 ring-inset",
        tone,
      )}
    >
      {approvalStatusLabel(status)}
    </span>
  );
}
