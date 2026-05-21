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

// Per OCCA design guideline: title + body stay white across variants.
// Only background tint AND icon color carry variant signal — icon stays
// colored to keep the alert immediately scan-recognizable, but body
// copy avoids low-contrast variant-tinted text.
const TITLE_COLOR = "text-white";
const BODY_COLOR = "text-white/70";

const config: Record<
  AlertVariant,
  { bg: string; iconColor: string; defaultIcon: ReactNode }
> = {
  error: {
    bg: "rgba(239,68,68,0.18)",
    iconColor: "text-red-300",
    defaultIcon: <AlertCircle className="size-3.5 shrink-0 mt-0.5" />,
  },
  warning: {
    bg: "rgba(245,158,11,0.18)",
    iconColor: "text-amber-300",
    defaultIcon: <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />,
  },
  success: {
    bg: "rgba(16,185,129,0.18)",
    iconColor: "text-emerald-300",
    defaultIcon: <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />,
  },
  info: {
    bg: "rgba(56,189,248,0.16)",
    iconColor: "text-sky-300",
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
      {resolvedIcon && <span className={c.iconColor}>{resolvedIcon}</span>}
      <div className="flex-1 min-w-0">
        {title && (
          <p className={`font-semibold leading-snug ${TITLE_COLOR}`}>{title}</p>
        )}
        {children && (
          <div
            className={`leading-relaxed ${title ? "mt-0.5" : ""} ${BODY_COLOR}`}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
