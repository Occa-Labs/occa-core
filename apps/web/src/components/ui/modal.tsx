"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { surface, shadow, border, specularStyle } from "@/components/ui/tokens";

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
  const [visible, setVisible] = useState(false);
  const prevOpen = useRef(false);

  // Hydration guard
  useEffect(() => { setMounted(true); }, []);

  // Animate in/out
  useEffect(() => {
    if (open && !prevOpen.current) {
      // tiny delay so the DOM is painted before we flip visible
      const t = requestAnimationFrame(() => setVisible(true));
      prevOpen.current = true;
      return () => cancelAnimationFrame(t);
    }
    if (!open && prevOpen.current) {
      setVisible(false);
      prevOpen.current = false;
    }
  }, [open]);

  // Escape key
  useEffect(() => {
    if (!open || !dismissable) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, dismissable, onClose]);

  if (!mounted || !open) return null;

  const hasHeader = !!title;

  return createPortal(
    // ── Backdrop ─────────────────────────────────────────────────────────────
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        zIndex,
        background: visible ? "rgba(0,0,0,0.48)" : "rgba(0,0,0,0)",
        backdropFilter: visible ? "blur(8px) saturate(1.4)" : "blur(0px)",
        WebkitBackdropFilter: visible ? "blur(8px) saturate(1.4)" : "blur(0px)",
        transition: "background 220ms ease, backdrop-filter 220ms ease",
      }}
      onClick={dismissable ? onClose : undefined}
    >
      {/* ── Glass card ─────────────────────────────────────────────────────── */}
      <div
        className={`relative flex flex-col overflow-hidden mx-4 ${widthClassName ?? ""}`}
        style={{
          width: widthClassName ? undefined : (width ?? "min(520px, 92vw)"),
          maxWidth: widthClassName ? undefined : "92vw",
          maxHeight,
          ...surface.elevated,
          borderRadius: 20,
          boxShadow: shadow.lg,
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1) translateY(0)" : "scale(0.95) translateY(8px)",
          transition: "opacity 220ms cubic-bezier(0.16,1,0.3,1), transform 220ms cubic-bezier(0.16,1,0.3,1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Specular top edge ─────────────────────────────────────────── */}
        <div className="absolute inset-x-0 top-0 h-px pointer-events-none" style={specularStyle} />

        {/* ── Header ────────────────────────────────────────────────────── */}
        {hasHeader && (
          <div
            className="shrink-0 flex items-center gap-3 px-4 py-3 select-none"
            style={{ borderBottom: border.divider }}
          >
            {/* Traffic-light close */}
            <button
              onClick={onClose}
              aria-label="Close"
              className="size-3.5 rounded-full flex items-center justify-center group/close transition-colors"
              style={{ background: "rgba(255,255,255,0.10)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,80,80,0.70)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.10)")}
            >
              <X className="size-2 text-white/0 group-hover/close:text-white/90 transition-colors" />
            </button>

            {/* Title */}
            <div className="flex-1 min-w-0 text-center">
              <p className="text-[13px] font-semibold text-white/75 tracking-tight truncate leading-none">
                {title}
              </p>
              {subtitle && (
                <p className="text-[11px] text-white/38 mt-0.5 truncate">{subtitle}</p>
              )}
            </div>

            {/* Right slot — keeps title visually centred */}
            <div className="size-3.5 shrink-0 flex items-center justify-end">
              {headerRight}
            </div>
          </div>
        )}

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {children}
        </div>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        {footer && (
          <div
            className="shrink-0"
            style={{ borderTop: border.divider }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
