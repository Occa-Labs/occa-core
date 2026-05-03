"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { surface, shadow } from "@/components/ui/tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DropdownItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Visual variant for destructive/highlighted actions. */
  variant?: "default" | "danger";
  disabled?: boolean;
  /** Renders a divider above this item. */
  dividerBefore?: boolean;
  onClick: () => void;
}

export interface DropdownProps {
  /** The element that opens the dropdown on click. */
  trigger: ReactNode;
  items: DropdownItem[];
  /** Controlled open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Horizontal alignment relative to trigger. Default: "left". */
  align?: "left" | "right";
  className?: string;
}

// ── Portal menu ───────────────────────────────────────────────────────────────

function DropdownMenu({
  items,
  anchor,
  align,
  onClose,
}: {
  items: DropdownItem[];
  anchor: DOMRect;
  align: "left" | "right";
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, ready: false });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    const gap = 6;
    const vp = { w: window.innerWidth, h: window.innerHeight };

    let top = anchor.bottom + gap;
    if (top + mh > vp.h - 8) top = anchor.top - mh - gap;

    let left = align === "right" ? anchor.right - mw : anchor.left;
    if (left + mw > vp.w - 8) left = vp.w - mw - 8;
    if (left < 8) left = 8;

    setPos({ top, left, ready: true });
  }, [anchor, align]);

  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-300 py-1 rounded-xl overflow-hidden"
      style={{
        ...surface.elevated,
        boxShadow: shadow.lg,
        minWidth: Math.max(anchor.width, 160),
        top: pos.ready ? pos.top : anchor.bottom + 6,
        left: pos.ready ? pos.left : anchor.left,
        opacity: pos.ready ? 1 : 0,
        transform: pos.ready ? "scale(1) translateY(0)" : "scale(0.96) translateY(-4px)",
        transition: "opacity 140ms ease, transform 140ms cubic-bezier(0.16,1,0.3,1)",
        transformOrigin: "top left",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <div key={item.key}>
          {item.dividerBefore && (
            <div className="mx-2 my-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
          )}
          <button
            disabled={item.disabled}
            onClick={() => { item.onClick(); onClose(); }}
            className={`
              w-full flex items-center gap-2.5 px-3.5 py-2 text-[12px] font-medium text-left
              transition-colors duration-100 disabled:opacity-40 disabled:cursor-not-allowed
              ${item.variant === "danger"
                ? "text-red-300 hover:bg-red-500/12"
                : "text-white/75 hover:bg-white/8 hover:text-white/95"
              }
            `}
          >
            {item.icon && (
              <span className="size-3.5 flex items-center justify-center shrink-0 opacity-70">
                {item.icon}
              </span>
            )}
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function Dropdown({
  trigger,
  items,
  open: controlledOpen,
  onOpenChange,
  align = "left",
  className = "",
}: DropdownProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const handleToggle = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor(rect);
    const next = !isOpen;
    setInternalOpen(next);
    onOpenChange?.(next);
  }, [isOpen, onOpenChange]);

  const handleClose = useCallback(() => {
    setInternalOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  return (
    <div ref={triggerRef} className={`relative inline-flex ${className}`}>
      <div onClick={handleToggle} className="contents">
        {trigger}
      </div>
      {isOpen && anchor && (
        <DropdownMenu items={items} anchor={anchor} align={align} onClose={handleClose} />
      )}
    </div>
  );
}
