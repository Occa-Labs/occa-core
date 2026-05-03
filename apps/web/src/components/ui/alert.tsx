import type { HTMLAttributes, ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlertVariant = "error" | "warning" | "success" | "info";

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  /** Override the default icon. Pass `null` to hide. */
  icon?: ReactNode | null;
  title?: string;
  children?: ReactNode;
}

// ── Config ────────────────────────────────────────────────────────────────────

const config: Record<
  AlertVariant,
  { bg: string; titleColor: string; bodyColor: string; defaultIcon: ReactNode }
> = {
  error: {
    bg: "rgba(239,68,68,0.12)",
    titleColor: "text-red-300",
    bodyColor: "text-red-200/70",
    defaultIcon: <AlertCircle className="size-3.5 shrink-0 mt-0.5" />,
  },
  warning: {
    bg: "rgba(245,158,11,0.12)",
    titleColor: "text-amber-300",
    bodyColor: "text-amber-200/70",
    defaultIcon: <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />,
  },
  success: {
    bg: "rgba(16,185,129,0.12)",
    titleColor: "text-emerald-300",
    bodyColor: "text-emerald-200/70",
    defaultIcon: <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />,
  },
  info: {
    bg: "rgba(56,189,248,0.10)",
    titleColor: "text-sky-300",
    bodyColor: "text-sky-200/70",
    defaultIcon: <Info className="size-3.5 shrink-0 mt-0.5" />,
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

export function Alert({
  variant = "info",
  icon,
  title,
  children,
  className = "",
  style,
  ...props
}: AlertProps) {
  const c = config[variant];
  const resolvedIcon = icon === null ? null : (icon ?? c.defaultIcon);

  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[12px] ${className}`}
      style={{
        background: c.bg,
        ...style,
      }}
      {...props}
    >
      {resolvedIcon && (
        <span className={c.titleColor}>{resolvedIcon}</span>
      )}
      <div className="flex-1 min-w-0">
        {title && (
          <p className={`font-semibold leading-snug ${c.titleColor}`}>{title}</p>
        )}
        {children && (
          <div className={`leading-relaxed ${title ? "mt-0.5" : ""} ${c.bodyColor}`}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
