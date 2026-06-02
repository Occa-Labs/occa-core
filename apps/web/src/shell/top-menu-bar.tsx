"use client";

import { WalletConnectOverlay } from "@/features/auth/components/wallet-connect-overlay";
import { NotificationCenter } from "@/features/notifications/components/notification-center";
import type { ParsedNotificationLink } from "@/features/notifications/utils";
import { Home } from "lucide-react";
import { OccaLogo } from "@/components/icons/occa-logo";
import { ChainBadge } from "./chain-badge";
import { FpsIndicator } from "./fps-indicator";
import { ViewModeToggle } from "./view-mode-toggle";

interface TopMenuBarProps {
  /** Mirrors NotificationCenter — only render the bell when company data
   *  + notification polling are valid (post-onboarding, authenticated). */
  notificationsEnabled: boolean;
  /** Current 3D vs 2D mode + setter, hoisted from page so the value
   *  persists across the OsShell mount. */
  viewMode3d: boolean;
  onToggleViewMode: () => void;
  /** Hide the 3D/2D toggle outside of the live OS phase. The toggle
   *  controls scene rendering inside OsShell — exposing it during
   *  onboarding/kickoff implies a feature that doesn't apply yet. */
  viewModeToggleEnabled: boolean;
  /** Notification deep-link dispatcher. Fired when a notification card is
   *  clicked and carries a parseable link. */
  onNavigate?: (parsed: ParsedNotificationLink) => void;
  /** When set, a Home button appears next to the logo that leaves the
   *  company OS and returns to the user dashboard. */
  onExitCompany?: () => void;
}

// macOS-style top menu bar. Spans the full width: OCCA logo pinned to
// the left, status cluster (chain → FPS → 3D toggle → bell → wallet)
// on the right. Items sit directly on the page (no shared bg) — only
// the wallet/bell/3D pills carry their own background.
export function TopMenuBar({
  notificationsEnabled,
  viewMode3d,
  onToggleViewMode,
  viewModeToggleEnabled,
  onNavigate,
  onExitCompany,
}: TopMenuBarProps) {
  return (
    <div className="fixed inset-x-3 top-2 z-110 flex items-center justify-between text-white/70 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-2 pl-4">
        <OccaLogo className="text-white/85" width={22} height={22} />
        {onExitCompany && (
          <button
            type="button"
            onClick={onExitCompany}
            aria-label="Back to home"
            title="Back to home"
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-xs font-medium text-white/85 transition-colors hover:bg-white/15"
          >
            <Home className="size-4" />
            Home
          </button>
        )}
      </div>

      <div className="pointer-events-auto flex items-center gap-2">
        <ChainBadge />
        <FpsIndicator embedded />
        {viewModeToggleEnabled && (
          <ViewModeToggle
            enabled={viewMode3d}
            onToggle={onToggleViewMode}
            embedded
          />
        )}
        <NotificationCenter
          enabled={notificationsEnabled}
          embedded
          onNavigate={onNavigate}
        />
        <WalletConnectOverlay embedded />
      </div>
    </div>
  );
}
