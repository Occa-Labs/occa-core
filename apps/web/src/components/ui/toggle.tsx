"use client";

import { Loader2, Lock } from "lucide-react";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  label?: string;
  "aria-label"?: string;
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  loading = false,
  label,
  "aria-label": ariaLabel,
}: ToggleProps) {
  const isOff = !checked || disabled;
  const activeOn = checked && !disabled;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={activeOn}
      aria-label={ariaLabel ?? label}
      onClick={() => { if (!disabled && !loading) onChange(!checked); }}
      disabled={disabled || loading}
      className={`relative shrink-0 h-5 w-9 rounded-full transition-colors ${
        disabled
          ? "bg-white/5 cursor-not-allowed"
          : loading
            ? "bg-white/15 cursor-wait"
            : activeOn
              ? "bg-emerald-500/80 hover:bg-emerald-500"
              : "bg-white/15 hover:bg-white/20"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform ${
          activeOn ? "translate-x-4" : "translate-x-0"
        } flex items-center justify-center`}
      >
        {loading
          ? <Loader2 className="size-2.5 text-gray-400 animate-spin" />
          : disabled && isOff
            ? <Lock className="size-2 text-white/50" />
            : null
        }
      </span>
    </button>
  );
}
