"use client";

import { Link2, X } from "lucide-react";

interface AnchorReminderBannerProps {
  /** Number of agents still pending on-chain anchor. Drives the copy. */
  pendingCount: number;
  /** Click handler — clears the skip flag and re-routes the user back
   *  into the kickoff anchor flow (KickoffWindow + AnchorPanel). */
  onResume: () => void;
  /** Optional dismiss — hides the banner for the current session only.
   *  Skip flag stays in localStorage; banner reappears next refresh. */
  onDismiss?: () => void;
}

/**
 * Reminder banner shown in OsShell when the user previously skipped
 * anchoring kickoff agents on-chain. Persistent across refresh until
 * either the user anchors (auto-clears flag) or dismisses for the
 * session. Pinned to the top-center, just below the TopMenuBar.
 */
export function AnchorReminderBanner({
  pendingCount,
  onResume,
  onDismiss,
}: AnchorReminderBannerProps) {
  return (
    <div className="fixed left-1/2 top-12 z-90 -translate-x-1/2 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-amber-300/25 bg-amber-500/10 backdrop-blur-md px-4 h-9 text-sm shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <Link2 className="size-4 text-amber-200/90 shrink-0" />
        <span className="text-white/90">
          {pendingCount} agent{pendingCount === 1 ? "" : "s"} need on-chain
          anchor
        </span>
        <button
          type="button"
          onClick={onResume}
          className="rounded-full bg-white/15 hover:bg-white/25 px-3 py-1 text-[11px] font-medium text-white transition-colors cursor-pointer"
        >
          Anchor now
        </button>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="size-5 rounded-full flex items-center justify-center text-white/45 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
