"use client";

import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  computePosition,
  flip,
  offset,
  shift,
  size,
  type VirtualElement,
} from "@floating-ui/dom";
import { X } from "lucide-react";
import { border, specularStyle } from "@/components/ui/tokens";

const GAP = 8;
const VIEWPORT_PADDING = 12;

export interface FloatingPanelProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  width?: number;
  /**
   * Fixed panel height in px. When set, the panel renders at this height
   * regardless of content (still capped by viewport). Useful for sustained
   * editing surfaces (task detail) where users want predictable real
   * estate — the body needs `flex-1 overflow-y-auto` to fill + scroll.
   */
  height?: number;
  /**
   * DOMRect of the element that opened this panel.
   * When provided, Floating UI positions the panel near the trigger with
   * automatic flip/shift/size middleware.
   */
  triggerRect?: DOMRect | null;
  /** Fallback when triggerRect is not provided. Defaults to viewport center-top. */
  defaultPosition?: { x: number; y: number };
  zIndex?: number;
  headerRight?: ReactNode;
}

// Off-screen starting coords: panel renders invisible at first, Floating UI
// places it correctly on first layout effect. Prevents the flash-of-wrong-
// position that a naive initial guess would cause.
const INITIAL_OFFSCREEN = { x: -9999, y: -9999 };

export function FloatingPanel({
  title,
  subtitle,
  children,
  onClose,
  width = 400,
  height,
  triggerRect,
  defaultPosition,
  zIndex = 200,
  headerRight,
}: FloatingPanelProps) {
  const [pos, setPos] = useState<{ x: number; y: number }>(INITIAL_OFFSCREEN);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [placed, setPlaced] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Remember the rect across re-renders without re-running placement when the
  // parent happens to pass a new DOMRect instance with identical values.
  const triggerRectRef = useRef(triggerRect ?? null);
  triggerRectRef.current = triggerRect ?? null;

  // Run Floating UI placement once on mount. `flip` swaps placement if the
  // preferred side is cramped; `shift` nudges the panel back into view along
  // the cross-axis; `size` caps height to the available space so the body can
  // scroll instead of overflowing the viewport.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    // No trigger → use defaultPosition or viewport-centered fallback.
    if (!triggerRectRef.current) {
      const fallback = defaultPosition ?? {
        x: Math.round((window.innerWidth - width) / 2),
        y: Math.round(window.innerHeight * 0.18),
      };
      setPos(fallback);
      setPlaced(true);
      return;
    }

    // Tall panels (sustained editing surfaces). Anchoring a 90vh popover
    // to a kanban card sends it past the viewport bottom because the
    // trigger position gates the start coordinate. Skip Floating UI here
    // and place the panel near the trigger horizontally but always
    // top-aligned vertically — the user still gets visual association
    // with the card they clicked, without the cut-off problem.
    if (height !== undefined) {
      const rect = triggerRectRef.current;
      const x = Math.max(
        VIEWPORT_PADDING,
        Math.min(rect.x, window.innerWidth - width - VIEWPORT_PADDING),
      );
      setPos({ x: Math.round(x), y: VIEWPORT_PADDING });
      setPlaced(true);
      return;
    }

    const rect = triggerRectRef.current;
    const virtualRef: VirtualElement = {
      getBoundingClientRect: () => rect,
    };

    let cancelled = false;
    void computePosition(virtualRef, panel, {
      placement: "bottom-start",
      strategy: "fixed",
      middleware: [
        offset(GAP),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
        size({
          padding: VIEWPORT_PADDING,
          apply({ availableHeight }) {
            if (cancelled) return;
            // When the caller asks for an explicit height, don't auto-cap
            // to availableHeight (space below the trigger). `shift`'s
            // default mainAxis behavior will slide the panel vertically
            // into view, and the inline `height` already respects the
            // viewport because callers pass viewport-relative values.
            if (height !== undefined) return;
            setMaxHeight(Math.max(120, Math.floor(availableHeight)));
          },
        }),
      ],
    }).then(({ x, y }) => {
      if (cancelled) return;
      setPos({ x: Math.round(x), y: Math.round(y) });
      setPlaced(true);
    });

    return () => {
      cancelled = true;
    };
  }, [defaultPosition, width, height]);

  const onDragDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: pos.x,
        originY: pos.y,
      };
    },
    [pos],
  );

  // Clamp while dragging so the panel can't be tossed off-screen. Floating UI
  // handles the initial placement; drag is user-controlled so we clamp here.
  const onDragMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const el = panelRef.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nextX = dragRef.current.originX + e.clientX - dragRef.current.startX;
    const nextY = dragRef.current.originY + e.clientY - dragRef.current.startY;
    setPos({
      x: Math.max(VIEWPORT_PADDING, Math.min(nextX, vw - w - VIEWPORT_PADDING)),
      y: Math.max(VIEWPORT_PADDING, Math.min(nextY, vh - h - VIEWPORT_PADDING)),
    });
  }, []);

  const onDragUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width,
        height,
        // When `height` is explicit, drop the maxHeight cap — the inline
        // height already enforces viewport-relative bounds at the call
        // site, and the auto-cap would otherwise win and shrink the panel.
        maxHeight:
          height !== undefined
            ? undefined
            : maxHeight ?? `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        zIndex,
        background: "rgba(22, 22, 28, 0.92)",
        backdropFilter: "blur(48px) saturate(1.7)",
        WebkitBackdropFilter: "blur(48px) saturate(1.7)",
        border: border.std,
        borderRadius: 16,
        boxShadow:
          "0 8px 40px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.06) inset",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        // Hide until Floating UI has placed the panel to avoid a 1-frame
        // flash at (-9999, -9999).
        visibility: placed ? "visible" : "hidden",
      }}
    >
      <div
        className="absolute inset-x-0 top-0 h-px pointer-events-none"
        style={specularStyle}
      />

      <div
        className="flex items-center gap-2 px-4 py-3 cursor-grab active:cursor-grabbing select-none shrink-0"
        style={{ borderBottom: border.divider }}
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
      >
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-white/80 truncate leading-none">
            {title}
          </p>
          {subtitle && (
            <p className="text-[11px] text-white/35 mt-0.5 truncate">
              {subtitle}
            </p>
          )}
        </div>
        {headerRight && (
          <div onPointerDown={(e) => e.stopPropagation()}>{headerRight}</div>
        )}
        <button
          type="button"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          className="size-5 rounded-full flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
          aria-label="Close"
        >
          <X className="size-3" />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</div>
    </div>,
    document.body,
  );
}
