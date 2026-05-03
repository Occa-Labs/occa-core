"use client";

import { useEffect, useState } from "react";
import { RecorderHud, RecordedPathModal } from "./dev-hud";

interface DevHudOverlayProps {
  /** True while the recorder is actively running — shows the on-screen HUD. */
  active: boolean;
  /** Non-null when a path was just captured — opens the copy-to-clipboard modal. */
  recordedCode: string | null;
  copied: boolean;
  onCopy: () => void;
  onCloseModal: () => void;
  /** Total dialog markers placed in the current recording. */
  markerCount?: number;
  /** `performance.now()` timestamp of the most recent marker, used to
   *  flash a confirmation chip briefly so the user knows SPACE registered. */
  markerFlashAt?: number;
}

// Bundles the two non-Canvas dev surfaces (HUD + modal) so office-scene can
// dynamic-import them as a single chunk. The Canvas-side WaypointRecorder is
// imported separately because it needs to mount inside <Canvas>.
export function DevHudOverlay({
  active,
  recordedCode,
  copied,
  onCopy,
  onCloseModal,
  markerCount = 0,
  markerFlashAt = 0,
}: DevHudOverlayProps) {
  // Show a "● Marker N" chip for ~1.2s after each marker press.
  const [flashVisible, setFlashVisible] = useState(false);
  useEffect(() => {
    if (!markerFlashAt) return;
    setFlashVisible(true);
    const t = window.setTimeout(() => setFlashVisible(false), 1200);
    return () => window.clearTimeout(t);
  }, [markerFlashAt]);

  return (
    <>
      {active && <RecorderHud />}
      {active && markerCount > 0 && (
        <div
          className={`fixed left-1/2 top-12 z-60 -translate-x-1/2 transition-opacity duration-200 ${
            flashVisible ? "opacity-100" : "opacity-60"
          }`}
        >
          <div className="glass rounded-full px-4 py-1.5 text-xs text-white/85 flex items-center gap-2">
            <span className="text-amber-400">●</span>
            <span className="font-medium">
              Marker {markerCount} {flashVisible ? "captured" : "saved"}
            </span>
          </div>
        </div>
      )}
      {recordedCode && (
        <RecordedPathModal
          code={recordedCode}
          copied={copied}
          onCopy={onCopy}
          onClose={onCloseModal}
        />
      )}
    </>
  );
}
