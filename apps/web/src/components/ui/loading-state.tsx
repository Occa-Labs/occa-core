import { Loader2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoadingStateProps {
  message?: string;
  /** Fills its container height. Default: true. */
  fill?: boolean;
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LoadingState({
  message = "Loading…",
  fill = true,
  className = "",
}: LoadingStateProps) {
  return (
    <div
      className={`flex items-center justify-center gap-2 text-[12px] text-white/35 ${fill ? "h-full" : ""} ${className}`}
    >
      <Loader2 className="size-3.5 animate-spin shrink-0" />
      <span>{message}</span>
    </div>
  );
}
