"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes, ImageIcon } from "lucide-react";
import { surface } from "@/components/ui/tokens";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "occa_view_3d";

/**
 * Persisted toggle for the 3D office scene. Off → render a static
 * background image instead. Initial value is `true` (3D on) — the office
 * is the canonical OCCA visual; flat mode is opt-in for users who want a
 * lighter rendering load.
 */
export function useViewMode(): { enabled: boolean; toggle: () => void } {
  const [enabled, setEnabled] = useState<boolean>(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) setEnabled(stored === "true");
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      }
      return next;
    });
  }, []);

  return { enabled, toggle };
}

interface ViewModeToggleProps {
  enabled: boolean;
  onToggle: () => void;
  /** Drop the fixed positioning + own glass surface for inline rendering
   *  inside the TopMenuBar. */
  embedded?: boolean;
}

/**
 * Top-bar icon button — toggles between 3D office and 2D static background.
 * In embedded mode: plain 32×32 button, no own bg, matches the bell's
 * sizing. In standalone mode: own glass surface, fixed top-right.
 */
export function ViewModeToggle({ enabled, onToggle, embedded = false }: ViewModeToggleProps) {
  const button = (
    <button
      type="button"
      onClick={onToggle}
      aria-label={enabled ? "Switch to 2D background" : "Switch to 3D office"}
      title={enabled ? "Switch to 2D background" : "Switch to 3D office"}
      aria-pressed={enabled}
      className={cn(
        "relative inline-flex items-center justify-center transition-colors duration-200",
        embedded
          ? "h-8 w-8 rounded-lg text-white/70 hover:text-white"
          : "h-9 w-9 rounded-xl",
        !embedded && (enabled
          ? "bg-white text-black hover:bg-white/90"
          : "text-white/80 hover:bg-white/12 hover:text-white"),
        embedded && enabled && "bg-white/15 text-white",
      )}
      style={!embedded && !enabled ? surface.base : undefined}
    >
      {enabled ? <Boxes className="h-5 w-5" /> : <ImageIcon className="h-5 w-5" />}
    </button>
  );

  if (embedded) return button;

  return (
    <div className="fixed top-4 z-50" style={{ right: 188 }}>
      {button}
    </div>
  );
}
