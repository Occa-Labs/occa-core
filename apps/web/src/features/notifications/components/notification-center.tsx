"use client";

// Operator notification bell. Reads from `/api/notifications` — not
// approvals anymore — so non-approval kinds (treasury readiness, anchor
// failures, etc.) show in the same inbox.
//
// Card click flow:
//   1. mark-read mutation (auto, no confirmation)
//   2. if notification.link set → invoke onNavigate(parsed)
//   3. close panel
//
// Approval-pending notifications carry link "approvals:<approvalId>";
// the host routes that into the existing ApprovalsWindow deep-link.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, X } from "lucide-react";
import type { NotificationDTO } from "@occa/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { surface } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";
import { useNotificationsList } from "../api/use-notifications-list";
import { useMarkNotificationRead } from "../api/use-mark-read";
import { useDismissNotification } from "../api/use-dismiss";
import { useReadAllNotifications } from "../api/use-read-all";
import {
  parseNotificationLink,
  relativeTime,
  type ParsedNotificationLink,
} from "../utils";

interface NotificationCenterProps {
  enabled: boolean;
  /** Inline-into-TopMenuBar vs free-floating chrome. Same flag as old
   *  NotificationCenter — placement code unchanged. */
  embedded?: boolean;
  /** Deep-link routing — fired when a notification card is clicked AND it
   *  carries a parseable link. Host decides which window to open based on
   *  parsed.window. */
  onNavigate?: (parsed: ParsedNotificationLink) => void;
}

const BELL_OFFSET_PX = 140;

export function NotificationCenter({
  enabled,
  embedded = false,
  onNavigate,
}: NotificationCenterProps) {
  const query = useNotificationsList(enabled);
  const data = query.data;
  const notifications = useMemo(
    () =>
      // Hide dismissed so they don't loiter in the list. Server still
      // returns them (audit/history) but UI shows only the live inbox.
      (data?.notifications ?? []).filter((n) => !n.dismissedAt),
    [data],
  );
  const unreadCount = data?.unreadCount ?? 0;

  const [bellOpen, setBellOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const markRead = useMarkNotificationRead();
  const dismiss = useDismissNotification();
  const readAll = useReadAllNotifications();

  useEffect(() => {
    if (!bellOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBellOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [bellOpen]);

  const handleCardClick = useCallback(
    (n: NotificationDTO) => {
      if (!n.readAt) markRead.mutate(n.id);
      const parsed = parseNotificationLink(n.link);
      if (parsed && onNavigate) onNavigate(parsed);
      setBellOpen(false);
    },
    [markRead, onNavigate],
  );

  const handleDismiss = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      dismiss.mutate(id);
    },
    [dismiss],
  );

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      className={cn(embedded ? "relative" : "fixed top-4 z-50")}
      style={embedded ? undefined : { right: `${BELL_OFFSET_PX}px` }}
    >
      <NotificationBell
        count={unreadCount}
        open={bellOpen}
        onClick={() => setBellOpen((v) => !v)}
        embedded={embedded}
      />
      {bellOpen && (
        <NotificationPanel
          notifications={notifications}
          unreadCount={unreadCount}
          onCardClick={handleCardClick}
          onDismiss={handleDismiss}
          onReadAll={() => readAll.mutate()}
          readAllPending={readAll.isPending}
        />
      )}
    </div>
  );
}

// ── Bell button ───────────────────────────────────────────────────────

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
        "relative inline-flex items-center justify-center transition-colors duration-200 cursor-pointer",
        embedded
          ? "h-7 w-7 rounded-full bg-white/10 text-white/70 hover:bg-white/15 hover:text-white"
          : "h-9 w-9 rounded-xl text-white/80 hover:bg-white/12 hover:text-white",
      )}
      style={embedded ? undefined : surface.base}
    >
      <Bell className={embedded ? "size-4" : "h-5 w-5"} />
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

// ── Bell panel ────────────────────────────────────────────────────────

interface NotificationPanelProps {
  notifications: NotificationDTO[];
  unreadCount: number;
  onCardClick: (n: NotificationDTO) => void;
  onDismiss: (e: React.MouseEvent, id: string) => void;
  onReadAll: () => void;
  readAllPending: boolean;
}

function NotificationPanel({
  notifications,
  unreadCount,
  onCardClick,
  onDismiss,
  onReadAll,
  readAllPending,
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
      <div className="flex items-center justify-between">
        <Badge variant="info" size="md" className="normal-case tracking-normal">
          <Bell className="h-3.5 w-3.5" />
          Notifications
        </Badge>
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReadAll}
            disabled={readAllPending}
            className="h-7 text-[11px] text-white/60 hover:text-white"
          >
            <Check className="h-3 w-3" />
            Mark all read
          </Button>
        )}
      </div>

      {notifications.length === 0 ? (
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
          {notifications.map((n) => (
            <NotificationCard
              key={n.id}
              notification={n}
              onClick={onCardClick}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────

interface NotificationCardProps {
  notification: NotificationDTO;
  onClick: (n: NotificationDTO) => void;
  onDismiss: (e: React.MouseEvent, id: string) => void;
}

function NotificationCard({
  notification,
  onClick,
  onDismiss,
}: NotificationCardProps) {
  const unread = notification.readAt === null;
  const time = relativeTime(notification.createdAt);
  return (
    <Card
      variant="elevated"
      padding="sm"
      interactive
      onClick={() => onClick(notification)}
      className="select-none group"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            "mt-1 h-2 w-2 shrink-0 rounded-full",
            unread ? "bg-sky-400" : "bg-white/15",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-white/90">
              {notification.title}
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-white/40">
              {time}
            </span>
          </div>
          {notification.body && (
            <div className="mt-0.5 line-clamp-2 text-[12px] text-white/60">
              {notification.body}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={(e) => onDismiss(e, notification.id)}
          className={cn(
            "shrink-0 rounded p-1 text-white/30 transition-colors cursor-pointer",
            "opacity-0 group-hover:opacity-100",
            "hover:bg-white/10 hover:text-white/80",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </Card>
  );
}
