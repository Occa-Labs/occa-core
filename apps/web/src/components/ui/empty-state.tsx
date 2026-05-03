import type { ReactNode } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  /** Icon element rendered in the rounded square. */
  icon: ReactNode;
  title: string;
  description?: string;
  /** Optional action button / link rendered below the description. */
  action?: ReactNode;
  /** Fills its container height. Default: true. */
  fill?: boolean;
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
  fill = true,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-4 text-center px-6 ${fill ? "h-full" : "py-12"} ${className}`}
    >
      <div
        className="size-12 rounded-2xl flex items-center justify-center text-white/25"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        {icon}
      </div>

      <div className="space-y-1">
        <p className="text-[13px] font-semibold text-white/50">{title}</p>
        {description && (
          <p className="text-[11px] text-white/28 leading-relaxed max-w-[220px]">
            {description}
          </p>
        )}
      </div>

      {action && <div>{action}</div>}
    </div>
  );
}
