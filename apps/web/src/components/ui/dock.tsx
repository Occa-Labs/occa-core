"use client";

import { type ReactNode, useState, useRef, useCallback } from "react";
import { surface, shadow, border } from "@/components/ui/tokens";

export interface DockItem {
  icon: ReactNode;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}

interface DockProps {
  items: DockItem[];
}

function DockButton({ item }: { item: DockItem }) {
  const [hovered, setHovered] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEnter = useCallback(() => {
    setHovered(true);
    timerRef.current = setTimeout(() => setShowTooltip(true), 300);
  }, []);

  const onLeave = useCallback(() => {
    setHovered(false);
    setShowTooltip(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {item.active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-white/80" />
      )}

      <button
        onClick={item.onClick}
        className={`relative size-11 flex items-center justify-center rounded-xl transition-all duration-150 ${
          item.active
            ? "bg-white/12 text-white"
            : hovered
              ? "bg-white/10 text-white scale-110"
              : "text-white/50 hover:text-white"
        }`}
      >
        {item.icon}
        {item.badge !== undefined && item.badge > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold leading-none flex items-center justify-center ring-1 ring-black/40"
            aria-label={`${item.badge} unread`}
          >
            {item.badge > 99 ? "99+" : item.badge}
          </span>
        )}
      </button>

      <div
        className={`absolute left-full top-1/2 -translate-y-1/2 ml-2.5 pointer-events-none transition-all duration-150 ${
          showTooltip
            ? "opacity-100 translate-x-0"
            : "opacity-0 -translate-x-1"
        }`}
      >
        <span
          className="rounded-lg px-2.5 py-1.5 text-xs text-white/90 whitespace-nowrap font-medium"
          style={{ ...surface.elevated, border: border.subtle }}
        >
          {item.label}
        </span>
      </div>
    </div>
  );
}

export function Dock({ items }: DockProps) {
  return (
    <div
      className="fixed left-3 top-1/2 -translate-y-1/2 z-50 rounded-2xl p-1.5 flex flex-col gap-1"
      style={{ ...surface.base }}
    >
      {items.map((item) => (
        <DockButton key={item.label} item={item} />
      ))}
    </div>
  );
}
