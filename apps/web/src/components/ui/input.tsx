"use client";

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  /** Icon rendered on the left inside the input. */
  leading?: ReactNode;
  /** Icon/element rendered on the right inside the input. */
  trailing?: ReactNode;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, leading, trailing, className = "", style, id, ...props }, ref) => {
    const inputId = id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-[11px] text-white/50 font-medium">
            {label}
          </label>
        )}

        <div className="relative flex items-center">
          {leading && (
            <span className="absolute left-3 flex items-center text-white/35 pointer-events-none">
              {leading}
            </span>
          )}

          <input
            ref={ref}
            id={inputId}
            className={`
              w-full rounded-xl px-3.5 py-2.5 text-[13px] text-white/85
              placeholder:text-white/22
              bg-white/5 ring-1 ring-inset
              transition-all duration-150 outline-none
              disabled:opacity-50 disabled:cursor-not-allowed
              ${error
                ? "ring-red-500/40 focus:ring-red-500/60"
                : "ring-white/10 focus:ring-white/22"
              }
              ${leading  ? "pl-9"  : ""}
              ${trailing ? "pr-9"  : ""}
              ${className}
            `}
            style={style}
            {...props}
          />

          {trailing && (
            <span className="absolute right-3 flex items-center text-white/35 pointer-events-none">
              {trailing}
            </span>
          )}
        </div>

        {error && (
          <p className="text-[11px] text-red-300/80">{error}</p>
        )}
        {hint && !error && (
          <p className="text-[11px] text-white/30">{hint}</p>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";
