"use client";

import { WalletConnectOverlay } from "@/features/auth/components/wallet-connect-overlay";
import { NotificationCenter } from "@/components/notification-center";
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

// macOS-style top-right menu bar. Items sit directly on the page (no
// shared bg) — only the wallet pill carries its own background. Order:
// FPS → 3D toggle → bell → wallet.
export function TopMenuBar({
  notificationsEnabled,
  viewMode3d,
  onToggleViewMode,
}: TopMenuBarProps) {
  return (
    <div className="fixed right-3 top-2 z-110 flex items-center gap-3 text-white/70">
      <FpsIndicator embedded />
      <ViewModeToggle enabled={viewMode3d} onToggle={onToggleViewMode} embedded />
      <NotificationCenter enabled={notificationsEnabled} embedded />
      <WalletConnectOverlay embedded />
    </div>
  );
}
