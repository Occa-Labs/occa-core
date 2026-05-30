"use client";

import { useEffect, useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import type { AgentDTO } from "@occa/shared/types";
import { useApprovalsList } from "../api/use-approvals-list";
import type { DeployProposalRequest } from "../utils";
import { ApprovalsList } from "./approvals-list";
import { ApprovalDetail } from "./approval-detail";

interface ApprovalsWindowProps {
  agents: AgentDTO[];
  /** When set, auto-selects this approval on mount AND re-selects when
   *  the value changes (e.g. notification "Open in Approvals" clicks
   *  while the window is already open). */
  initialApprovalId?: string | null;
  /** Bubbles a "Deploy this" click on a deployment proposal up to the
   *  shell, which opens the pre-filled deploy modal. */
  onDeployProposal?: (req: DeployProposalRequest) => void;
  onClose?: () => void;
}

type ApprovalsView = "pending" | "history";

export function ApprovalsWindow({
  agents,
  initialApprovalId = null,
  onDeployProposal,
  onClose,
}: ApprovalsWindowProps) {
  const [view, setView] = useState<ApprovalsView>("pending");
  // Pending polls live; history fetches every status once (decided rows
  // are immutable) and shows only the non-pending ones.
  const pending = useApprovalsList(view === "pending", "pending");
  const history = useApprovalsList(view === "history");
  const list = view === "pending" ? pending : history;
  const approvals = useMemo(() => {
    const rows = list.data ?? [];
    return view === "pending"
      ? rows
      : rows.filter((a) => a.status !== "pending");
  }, [list.data, view]);

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
      subtitle={`${approvals.length} ${view === "pending" ? "pending" : "past"}`}
      onClose={onClose}
      defaultSize={{ w: 760, h: 560 }}
      minWidth={520}
      minHeight={400}
    >
      <div className="flex h-full">
        <div className="flex w-64 shrink-0 flex-col border-r border-white/8">
          <div className="shrink-0 border-b border-white/8 p-2">
            <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
              <ViewTab
                label="Pending"
                active={view === "pending"}
                onClick={() => setView("pending")}
              />
              <ViewTab
                label="History"
                active={view === "history"}
                onClick={() => setView("history")}
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ApprovalsList
              approvals={approvals}
              agentById={agentById}
              selectedId={selectedId}
              onSelect={setSelectedId}
              loading={list.isPending}
              emptyText={
                view === "pending"
                  ? "No pending approvals."
                  : "No past approvals yet."
              }
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <ApprovalDetail
              approval={selected}
              agentById={agentById}
              onDeployProposal={onDeployProposal}
            />
          ) : (
            <EmptyState view={view} />
          )}
        </div>
      </div>
    </AppWindow>
  );
}

function ViewTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 cursor-pointer rounded-md py-1 text-[11px] font-medium transition-colors ${
        active ? "bg-white/12 text-white" : "text-white/55 hover:text-white/80"
      }`}
    >
      {label}
    </button>
  );
}

function EmptyState({ view }: { view: ApprovalsView }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-white/40">
      <Inbox className="h-10 w-10" />
      <p className="text-sm">
        {view === "pending" ? "No approvals pending." : "No past approvals."}
      </p>
      <p className="text-xs text-white/30">
        {view === "pending"
          ? "Agents submit approval requests here when they need your decision."
          : "Decided approvals and deployed proposals show up here."}
      </p>
    </div>
  );
}
