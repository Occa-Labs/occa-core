import type { HTMLAttributes } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "purple"
  | "muted";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Adds a small pulsing dot before the label. */
  dot?: boolean;
  size?: "sm" | "md";
}

// ── Style map ─────────────────────────────────────────────────────────────────

const variantStyles: Record<BadgeVariant, React.CSSProperties> = {
  default: {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: "rgba(255,255,255,0.70)",
  },
  success: {
    background: "rgba(16,185,129,0.12)",
    border: "1px solid rgba(16,185,129,0.22)",
    color: "rgb(110,231,183)",
  },
  warning: {
    background: "rgba(245,158,11,0.12)",
    border: "1px solid rgba(245,158,11,0.22)",
    color: "rgb(252,211,77)",
  },
  error: {
    background: "rgba(239,68,68,0.12)",
    border: "1px solid rgba(239,68,68,0.22)",
    color: "rgb(252,165,165)",
  },
  info: {
    background: "rgba(56,189,248,0.10)",
    border: "1px solid rgba(56,189,248,0.18)",
    color: "rgb(125,211,252)",
  },
  purple: {
    background: "rgba(167,139,250,0.12)",
    border: "1px solid rgba(167,139,250,0.20)",
    color: "rgb(196,181,253)",
  },
  muted: {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.07)",
    color: "rgba(255,255,255,0.35)",
  },
};

const dotColors: Record<BadgeVariant, string> = {
  default: "bg-white/50",
  success:  "bg-emerald-400",
  warning:  "bg-amber-400",
  error:    "bg-red-400",
  info:     "bg-sky-400",
  purple:   "bg-violet-400",
  muted:    "bg-white/25",
};

// ── Component ─────────────────────────────────────────────────────────────────

export function Badge({
  variant = "default",
  dot = false,
  size = "sm",
  className = "",
  style,
  children,
  ...props
}: BadgeProps) {
  const sizeClass = size === "md"
    ? "px-2.5 py-1 text-[11px] gap-1.5"
    : "px-2 py-0.5 text-[10px] gap-1";

  return (
    <span
      className={`inline-flex items-center font-semibold rounded-full uppercase tracking-wide ${sizeClass} ${className}`}
      style={{ ...variantStyles[variant], ...style }}
      {...props}
    >
      {dot && (
        <span className={`shrink-0 rounded-full ${size === "md" ? "size-1.5" : "size-1"} ${dotColors[variant]}`} />
      )}
      {children}
    </span>
  );
}
