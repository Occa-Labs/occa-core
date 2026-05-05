"use client";

import { WalletConnectOverlay } from "@/features/auth/components/wallet-connect-overlay";
import { NotificationCenter } from "@/components/notification-center";
import { OccaLogo } from "@/components/icons/occa-logo";
import { ChainBadge } from "./chain-badge";
import { FpsIndicator } from "./fps-indicator";
import { ViewModeToggle } from "./view-mode-toggle";

interface TopMenuBarProps {
  /** Mirrors NotificationCenter — only render the bell when the company
   *  data + approval polling are valid (post-onboarding, authenticated). */
  notificationsEnabled: boolean;
  /** Current 3D vs 2D mode + setter, hoisted from page so the value
   *  persists across the OsShell mount. */
  viewMode3d: boolean;
  onToggleViewMode: () => void;
}

// macOS-style top menu bar. Spans the full width: OCCA logo pinned to
// the left, status cluster (chain → FPS → 3D toggle → bell → wallet)
// on the right. Items sit directly on the page (no shared bg) — only
// the wallet/bell/3D pills carry their own background.
export function TopMenuBar({
  notificationsEnabled,
  viewMode3d,
  onToggleViewMode,
}: TopMenuBarProps) {
  return (
    <div className="fixed inset-x-3 top-2 z-110 flex items-center justify-between text-white/70 pointer-events-none">
      <div className="pointer-events-auto flex items-center pl-4">
        <OccaLogo
          className="text-white/85 hover:text-white transition-colors"
          width={22}
          height={22}
        />
      </div>

      <div className="pointer-events-auto flex items-center gap-3">
        <ChainBadge />
        <FpsIndicator embedded />
        <ViewModeToggle
          enabled={viewMode3d}
          onToggle={onToggleViewMode}
          embedded
        />
        <NotificationCenter enabled={notificationsEnabled} embedded />
        <WalletConnectOverlay embedded />
      </div>
    </div>
  );
}
