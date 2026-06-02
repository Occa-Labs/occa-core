"use client";

import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { border, specularStyle } from "@/components/ui/tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Shown in the title bar. Omit for a bare shell (header hidden). */
  title?: string;
  subtitle?: string;
  /** Right side of the header row (e.g. badge, status pill). */
  headerRight?: ReactNode;
  /** Sticky footer area — rendered below the scrollable body. */
  footer?: ReactNode;
  children: ReactNode;
  dismissable?: boolean;
  /** CSS width value, e.g. "min(520px, 92vw)". Default: "min(520px, 92vw)". */
  width?: string;
  /** Tailwind max-width class, e.g. "max-w-lg". Prefer `width` for new usage. */
  widthClassName?: string;
  /** CSS max-height value. Default: "min(680px, 88vh)". */
  maxHeight?: string;
  zIndex?: number;
}

// ── Component ─────────────────────────────────────────────────────────────────
//
// Minimal rewrite 2026-05-11. Repeated click-not-firing bugs eliminated
// by stripping every non-essential layer:
//   - No backdrop-filter (was 60px blur + saturate via surface.elevated)
//   - No opacity transition (was masking the click-through bug)
//   - No prevOpen ref guard (strict-mode-hostile in dev)
//   - Solid background, instant mount/unmount
// Visual style stays close (dim backdrop, glass-tinted card with border
// and shadow) but rendering is fully GPU-cheap and click handlers are
// guaranteed to fire because there's nothing between the user and the
// onClick target.

const CARD_BACKGROUND = "rgba(26, 26, 32, 0.96)";

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  headerRight,
  footer,
  children,
  dismissable = true,
  width,
  widthClassName,
  maxHeight = "min(680px, 88vh)",
  zIndex = 200,
}: ModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open || !dismissable) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, dismissable, onClose]);

  if (!mounted || !open) return null;

  const hasHeader = !!title;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        zIndex,
        // Blur lives ONLY on the dimmer overlay, never on the card. The
        // 2026-05-11 rewrite removed the card's backdrop-filter to fix a
        // click-through bug (compositing layer swallowed clicks); blurring
        // this backdrop div is a separate element and safe.
        background: "rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
      }}
      // CRITICAL: stop pointerdown synth-bubble before it reaches the
      // AppWindow that hosts whatever opened this modal. React portal
      // events still travel up the React tree, and AppWindow's header
      // calls setPointerCapture() on its own div for drag — that capture
      // swallows every pointer event until pointerup, blocking onClick
      // inside the modal. Same fix pattern as floating-panel.tsx.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={dismissable ? onClose : undefined}
    >
      <div
        className={`relative flex flex-col overflow-hidden mx-4 ${widthClassName ?? ""}`}
        style={{
          width: widthClassName ? undefined : (width ?? "min(520px, 92vw)"),
          maxWidth: widthClassName ? undefined : "92vw",
          maxHeight,
          background: CARD_BACKGROUND,
          border: border.std,
          borderRadius: 20,
          boxShadow:
            "0 24px 64px rgba(0, 0, 0, 0.45), 0 4px 12px rgba(0, 0, 0, 0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="absolute inset-x-0 top-0 h-px pointer-events-none"
          style={specularStyle}
        />

        {hasHeader && (
          <div
            className="shrink-0 flex items-center gap-3 px-4 py-3 select-none"
            style={{ borderBottom: border.divider }}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="size-3.5 cursor-pointer rounded-full flex items-center justify-center group/close transition-colors"
              style={{ background: "rgba(255,255,255,0.10)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,80,80,0.70)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.10)")
              }
            >
              <X className="size-2 text-white/0 group-hover/close:text-white/90 transition-colors" />
            </button>

            <div className="flex-1 min-w-0 text-center">
              <p className="text-[13px] font-semibold text-white/75 tracking-tight truncate leading-none">
                {title}
              </p>
              {subtitle && (
                <p className="text-[11px] text-white/38 mt-0.5 truncate">
                  {subtitle}
                </p>
              )}
            </div>

            <div className="shrink-0 flex items-center justify-end min-w-3.5">
              {headerRight}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">{children}</div>

        {footer && (
          <div className="shrink-0" style={{ borderTop: border.divider }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
