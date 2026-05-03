"use client";

import { type ReactNode, useEffect } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  dismissable?: boolean;
  widthClassName?: string;
}

// Renders inline inside the nearest positioned ancestor. Wrap the content area
// in `relative overflow-hidden` so the drawer stays scoped to that region.
export function Drawer({
  open,
  onClose,
  children,
  dismissable = true,
  widthClassName = "max-w-xl",
}: DrawerProps) {
  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissable, onClose]);

  return (
    <div
      className={`absolute inset-0 z-40 transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-0 bg-black/35 backdrop-blur-[2px]"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        className={`absolute top-2 right-2 bottom-2 w-[calc(100%-1rem)] ${widthClassName} rounded-2xl overflow-hidden ring-1 ring-white/10 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)] transition-transform duration-250 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          open ? "translate-x-0" : "translate-x-[calc(100%+0.5rem)]"
        }`}
        style={{
          background: "rgba(20, 20, 24, 0.78)",
          backdropFilter: "blur(28px) saturate(140%)",
          WebkitBackdropFilter: "blur(28px) saturate(140%)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
