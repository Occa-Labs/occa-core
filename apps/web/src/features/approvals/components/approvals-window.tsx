"use client";

import { useEffect, useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import type { AgentDTO } from "@occa/shared/types";
import { useApprovalsList } from "../api/use-approvals-list";
import { ApprovalsList } from "./approvals-list";
import { ApprovalDetail } from "./approval-detail";

interface ApprovalsWindowProps {
  agents: AgentDTO[];
  /** When set, auto-selects this approval on mount AND re-selects when
   *  the value changes (e.g. notification "Open in Approvals" clicks
   *  while the window is already open). */
  initialApprovalId?: string | null;
  onClose?: () => void;
}

export function ApprovalsWindow({
  agents,
  initialApprovalId = null,
  onClose,
}: ApprovalsWindowProps) {
  const list = useApprovalsList(true, "pending");
  const approvals = list.data ?? [];

  const agentById = useMemo(() => {
    const map = new Map<string, AgentDTO>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(
    initialApprovalId,
  );

  // External re-selection: notification card click updates initialApprovalId.
  useEffect(() => {
    if (initialApprovalId) setSelectedId(initialApprovalId);
  }, [initialApprovalId]);

  // Auto-select first item when nothing is selected, OR clear selection
  // when the selected approval is decided + filtered out of the list.
  useEffect(() => {
    if (!selectedId && approvals.length > 0) {
      setSelectedId(approvals[0].id);
      return;
    }
    if (selectedId && !approvals.find((a) => a.id === selectedId)) {
      setSelectedId(approvals[0]?.id ?? null);
    }
  }, [approvals, selectedId]);

  const selected = selectedId
    ? (approvals.find((a) => a.id === selectedId) ?? null)
    : null;

  return (
    <AppWindow
      title="Approvals"
      subtitle={`${approvals.length} pending`}
      onClose={onClose}
      defaultSize={{ w: 760, h: 560 }}
      minWidth={520}
      minHeight={400}
    >
      <div className="flex h-full">
        <div className="w-64 shrink-0 border-r border-white/8 overflow-y-auto">
          <ApprovalsList
            approvals={approvals}
            agentById={agentById}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={list.isPending}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <ApprovalDetail approval={selected} agentById={agentById} />
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    </AppWindow>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-white/40">
      <Inbox className="h-10 w-10" />
      <p className="text-sm">No approvals pending.</p>
      <p className="text-xs text-white/30">
        Agents submit approval requests here when they need your decision.
      </p>
    </div>
  );
}
