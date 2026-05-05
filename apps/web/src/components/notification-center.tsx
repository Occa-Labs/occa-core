"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Bell, Bot, Check, X } from "lucide-react";
import type { AgentDTO, ApprovalDTO } from "@occa/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { MarkdownViewer } from "@/components/ui/markdown-viewer";
import { surface } from "@/components/ui/tokens";
import { useApprovals } from "@/hooks/use-approvals";
import { useMe } from "@/hooks/use-me";
import { cn } from "@/lib/utils";

interface NotificationCenterProps {
  enabled: boolean;
  /** When true, drop the fixed positioning so the bell can sit inline
   *  inside the TopMenuBar. The popup still anchors to the bell via
   *  position: relative, so the placement code below stays as-is. */
  embedded?: boolean;
}

// Wallet button is at right-4 top-4 with width ~ 95-130px depending on state.
// Bell sits to its left with an 8px gap. The right-[140px] offset is a touch
// generous on the small "Connect Wallet" state but never collides.
const BELL_OFFSET_PX = 140;

export function NotificationCenter({
  enabled,
  embedded = false,
}: NotificationCenterProps) {
  const me = useMe(enabled);
  const { approvals, decide } = useApprovals(enabled && me.company !== null);
  const [bellOpen, setBellOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const agentById = useMemo(() => {
    const map = new Map<string, AgentDTO>();
    for (const a of me.agents) map.set(a.id, a);
    return map;
  }, [me.agents]);

  // The selected approval drives the FloatingPanel detail view. If the
  // underlying row disappears (decided + removed from pending list), close
  // the detail automatically — its content would otherwise be stale.
  const selectedApproval = useMemo(
    () =>
      selectedId ? (approvals.find((a) => a.id === selectedId) ?? null) : null,
    [approvals, selectedId],
  );
  useEffect(() => {
    if (selectedId && !selectedApproval) {
      setSelectedId(null);
      setTriggerRect(null);
    }
  }, [selectedId, selectedApproval]);

  // Click-outside / Esc closes the bell panel. The FloatingPanel detail view
  // is portaled to document.body so its clicks are outside `containerRef`;
  // we suppress the auto-close while a detail is open by gating on
  // `selectedId == null`.
  useEffect(() => {
    if (!bellOpen) return;
    const onClick = (e: MouseEvent) => {
      if (selectedId !== null) return;
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the topmost UI: detail first, then bell.
      if (selectedId !== null) {
        setSelectedId(null);
        setTriggerRect(null);
        return;
      }
      setBellOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [bellOpen, selectedId]);

  const handleCardClick = useCallback(
    (approval: ApprovalDTO, rect: DOMRect) => {
      setSelectedId(approval.id);
      setTriggerRect(rect);
      // Close the bell panel so the detail isn't crowded against the stack
      // of cards behind it. The bell stays clickable to re-open.
      setBellOpen(false);
    },
    [],
  );

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setTriggerRect(null);
  }, []);

  if (!enabled) return null;

  const pendingCount = approvals.length;

  return (
    <>
      <div
        ref={containerRef}
        className={cn(embedded ? "relative" : "fixed top-4 z-50")}
        style={embedded ? undefined : { right: `${BELL_OFFSET_PX}px` }}
      >
        <NotificationBell
          count={pendingCount}
          open={bellOpen}
          onClick={() => setBellOpen((v) => !v)}
          embedded={embedded}
        />
        {bellOpen && (
          <NotificationPanel
            approvals={approvals}
            agentById={agentById}
            onCardClick={handleCardClick}
          />
        )}
      </div>

      {selectedApproval && (
        <NotificationDetail
          approval={selectedApproval}
          agent={
            selectedApproval.requestedByAgentId
              ? (agentById.get(selectedApproval.requestedByAgentId) ?? null)
              : null
          }
          agentById={agentById}
          triggerRect={triggerRect}
          onClose={closeDetail}
          onDecide={decide}
        />
      )}
    </>
  );
}

// ── Bell button (matches wallet-button chrome) ────────────────────────────────

interface NotificationBellProps {
  count: number;
  open: boolean;
  onClick: () => void;
  embedded?: boolean;
}

function NotificationBell({
  count,
  open,
  onClick,
  embedded = false,
}: NotificationBellProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Notifications${count > 0 ? ` (${count})` : ""}`}
      aria-expanded={open}
      className={cn(
        "relative inline-flex items-center justify-center transition-colors duration-200",
        embedded
          ? "h-8 w-8 rounded-full bg-white/10 text-white/70 hover:bg-white/15 hover:text-white"
          : "h-9 w-9 rounded-xl text-white/80 hover:bg-white/12 hover:text-white",
      )}
      style={embedded ? undefined : surface.base}
    >
      <Bell className="h-5 w-5" />
      {count > 0 && (
        <Badge
          variant="error"
          size="sm"
          className="absolute -right-1 -top-1 px-1.5 leading-none"
        >
          {count > 99 ? "99+" : count}
        </Badge>
      )}
    </button>
  );
}

// ── Bell panel — header pill + standalone card stack ──────────────────────────

interface NotificationPanelProps {
  approvals: ApprovalDTO[];
  agentById: Map<string, AgentDTO>;
  onCardClick: (approval: ApprovalDTO, rect: DOMRect) => void;
}

function NotificationPanel({
  approvals,
  agentById,
  onCardClick,
}: NotificationPanelProps) {
  return (
    <div
      className={cn(
        "absolute right-0 top-[calc(100%+8px)] w-90",
        "flex flex-col gap-2",
        "origin-top-right",
        "animate-in fade-in zoom-in-95 duration-200",
      )}
    >
      <div className="flex justify-center">
        <Badge variant="info" size="md" className="normal-case tracking-normal">
          <Bell className="h-3.5 w-3.5" />
          Notification
        </Badge>
      </div>

      {approvals.length === 0 ? (
        <Card
          variant="elevated"
          padding="sm"
          className="text-center text-[12px] text-white/40"
        >
          No notifications.
        </Card>
      ) : (
        <div
          className={cn(
            "flex max-h-[60vh] flex-col gap-2 overflow-y-auto",
            "mask-[linear-gradient(to_bottom,black_85%,transparent_100%)]",
          )}
        >
          {approvals.map((a) => (
            <NotificationCard
              key={a.id}
              approval={a}
              agent={
                a.requestedByAgentId
                  ? (agentById.get(a.requestedByAgentId) ?? null)
                  : null
              }
              agentById={agentById}
              onClick={onCardClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card — collapsed only; click opens the FloatingPanel detail ───────────────

interface NotificationCardProps {
  approval: ApprovalDTO;
  agent: AgentDTO | null;
  agentById: Map<string, AgentDTO>;
  onClick: (approval: ApprovalDTO, rect: DOMRect) => void;
}

function NotificationCard({
  approval,
  agent,
  agentById,
  onClick,
}: NotificationCardProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      onClick(approval, rect);
    },
    [approval, onClick],
  );

  const agentName = agent?.name ?? "Agent";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const time = relativeTime(approval.requestedAt);

  return (
    <Card
      variant="elevated"
      padding="sm"
      interactive
      onClick={handleClick}
      className="select-none"
    >
      <CardHeaderRow
        agentName={agentName}
        agentRole={agentRole}
        actionLabel={actionLabel}
        time={time}
      />
    </Card>
  );
}

// ── Detail (FloatingPanel) ────────────────────────────────────────────────────

interface NotificationDetailProps {
  approval: ApprovalDTO;
  agent: AgentDTO | null;
  agentById: Map<string, AgentDTO>;
  triggerRect: DOMRect | null;
  onClose: () => void;
  onDecide: (
    id: string,
    decision: "approve" | "reject",
    rejectionReason?: string,
  ) => Promise<boolean>;
}

type DetailMode =
  | { kind: "idle" }
  | { kind: "rejecting" }
  | { kind: "submitting" };

function NotificationDetail({
  approval,
  agent,
  agentById,
  triggerRect,
  onClose,
  onDecide,
}: NotificationDetailProps) {
  const [mode, setMode] = useState<DetailMode>({ kind: "idle" });
  const [rejectReason, setRejectReason] = useState("");

  const handleApprove = useCallback(async () => {
    setMode({ kind: "submitting" });
    const ok = await onDecide(approval.id, "approve");
    if (!ok) setMode({ kind: "idle" });
    // On success: the parent removes this approval from the list and
    // unmounts the detail; no manual close needed.
  }, [approval.id, onDecide]);

  const handleStartReject = useCallback(() => {
    setMode({ kind: "rejecting" });
  }, []);

  const handleCancelReject = useCallback(() => {
    setRejectReason("");
    setMode({ kind: "idle" });
  }, []);

  const handleSendReject = useCallback(async () => {
    const reason = rejectReason.trim();
    if (!reason) return;
    setMode({ kind: "submitting" });
    const ok = await onDecide(approval.id, "reject", reason);
    if (!ok) setMode({ kind: "rejecting" });
  }, [approval.id, onDecide, rejectReason]);

  const submitting = mode.kind === "submitting";
  const agentName = agent?.name ?? "Agent";
  const agentRole = agent?.role ?? null;
  const actionLabel = humanizeAction(
    approval.actionType,
    approval.payload,
    agentById,
  );
  const time = relativeTime(approval.requestedAt);

  return (
    <FloatingPanel
      title="Approval request"
      subtitle={actionLabel}
      onClose={onClose}
      triggerRect={triggerRect}
      width={400}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <CardHeaderRow
          agentName={agentName}
          agentRole={agentRole}
          actionLabel={actionLabel}
          time={time}
        />

        <PayloadDetail payload={approval.payload} />

        {mode.kind === "rejecting" ? (
          <div className="space-y-2">
            <textarea
              autoFocus
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection…"
              rows={3}
              className={cn(
                "w-full resize-none rounded-lg border border-white/10",
                "bg-black/25 px-2.5 py-2 text-[12px] text-white/85",
                "placeholder:text-white/30 focus:border-white/25 focus:outline-none",
              )}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelReject}
                disabled={submitting}
              >
                <X className="size-3" />
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={submitting || rejectReason.trim().length === 0}
                onClick={handleSendReject}
              >
                {submitting ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleStartReject}
              disabled={submitting}
            >
              Reject
            </Button>
            <Button
              variant="success"
              size="sm"
              onClick={() => void handleApprove()}
              disabled={submitting}
            >
              <Check className="size-3" />
              {submitting ? "Approving…" : "Approve"}
            </Button>
          </div>
        )}
      </div>
    </FloatingPanel>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────────

interface CardHeaderRowProps {
  agentName: string;
  agentRole: string | null;
  actionLabel: string;
  time: string;
}

function CardHeaderRow({
  agentName,
  agentRole,
  actionLabel,
  time,
}: CardHeaderRowProps) {
  return (
    <div className="flex items-start gap-3">
      <div
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/70"
        style={surface.recessed}
      >
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-white/90">
            {agentName}
          </span>
          {agentRole && (
            <span className="shrink-0 text-[11px] text-white/40">
              · {agentRole}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-white/40">
            {time}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-white/60">
          {actionLabel}
        </div>
      </div>
    </div>
  );
}

// Keys whose string values render as markdown in the detail view. Agents
// write description / acceptance / summary as prose with lists, code, and
// links — rendering them as plain text strips the formatting. Anything
// else (uuids, role slugs, names) stays as a plain monoline.
const MARKDOWN_KEYS = new Set([
  "description",
  "acceptanceCriteria",
  "summary",
  "note",
  "rejectionReason",
  "failureReason",
]);

// Detail view of the full payload — keys laid out vertically with values
// wrapping (vs the compact single-line preview on the card). Used inside
// the FloatingPanel where horizontal space is generous. Rich-text keys
// (see MARKDOWN_KEYS) render through MarkdownViewer; everything else
// uses a plain stringified value.
function PayloadDetail({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return (
      <Card variant="recessed" padding="sm">
        <p className="text-[12px] text-white/40">No additional details.</p>
      </Card>
    );
  }
  return (
    <Card variant="recessed" padding="md">
      <div className="flex flex-col gap-3 text-[12px]">
        {entries.map(([k, v]) => (
          <PayloadField key={k} label={k} value={v} />
        ))}
      </div>
    </Card>
  );
}

function PayloadField({ label, value }: { label: string; value: unknown }) {
  const isMarkdown = MARKDOWN_KEYS.has(label) && typeof value === "string";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-white/35">
        {label}
      </span>
      {isMarkdown ? (
        <MarkdownViewer
          content={value as string}
          hideToolbar
          viewMode="preview"
          className="text-white/85"
        />
      ) : (
        <span className="wrap-break-word text-white/85">
          {stringifyValue(value)}
        </span>
      )}
    </div>
  );
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

// Best-effort humanization. Approvals carry a free-form `actionType` string;
// when the actionType is a known structured kind (currently `delegate`,
// `hire`) we pull typed fields and resolve referenced agent IDs to names.
// Otherwise we fall back to `payload.summary` then a slug → "Wants to …"
// rendering.
function humanizeAction(
  actionType: string,
  payload: Record<string, unknown>,
  agentById: Map<string, AgentDTO>,
): string {
  if (actionType === "delegate") {
    const targetId =
      typeof payload.targetAgentId === "string" ? payload.targetAgentId : null;
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const targetName = targetId
      ? (agentById.get(targetId)?.name ?? null)
      : null;
    if (targetName && title)
      return `Wants to delegate to ${targetName}: "${title}"`;
    if (targetName) return `Wants to delegate to ${targetName}`;
    if (title) return `Wants to delegate: ${title}`;
    return "Wants to delegate to another agent";
  }

  if (actionType === "hire") {
    const targetRole =
      typeof payload.targetRole === "string" ? payload.targetRole : "";
    const targetName =
      typeof payload.targetName === "string" ? payload.targetName.trim() : "";
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (targetName && targetRole && title)
      return `Wants to hire ${targetName} (${targetRole}) for "${title}"`;
    if (targetName && targetRole)
      return `Wants to hire ${targetName} (${targetRole})`;
    if (targetRole) return `Wants to hire a new ${targetRole}`;
    return "Wants to hire a new agent";
  }

  const summary =
    typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  const pretty = actionType
    .split(/[._-]+/)
    .filter(Boolean)
    .join(" ");
  return pretty ? `Wants to ${pretty.toLowerCase()}` : "Awaiting your decision";
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
