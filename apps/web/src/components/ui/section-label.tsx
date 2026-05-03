import type { HTMLAttributes } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SectionLabelProps extends HTMLAttributes<HTMLParagraphElement> {
  /** Adds a top margin for use between sections. Default: false. */
  spaced?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SectionLabel({
  spaced = false,
  className = "",
  children,
  ...props
}: SectionLabelProps) {
  return (
    <p
      className={`
        text-[10px] uppercase tracking-widest font-semibold text-white/30
        ${spaced ? "mt-5 mb-2" : ""}
        ${className}
      `}
      {...props}
    >
      {children}
    </p>
  );
}
