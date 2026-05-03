"use client";

import { forwardRef, type SelectHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  /** Icon rendered on the left inside the select. */
  leading?: ReactNode;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, hint, error, leading, className = "", style, id, children, ...props }, ref) => {
    const selectId = id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={selectId} className="text-[11px] text-white/50 font-medium">
            {label}
          </label>
        )}

        <div className="relative flex items-center">
          {leading && (
            <span className="absolute left-3 flex items-center text-white/35 pointer-events-none z-10">
              {leading}
            </span>
          )}

          <select
            ref={ref}
            id={selectId}
            className={`
              w-full appearance-none rounded-xl px-3.5 py-2.5 pr-8 text-[13px] text-white/80
              bg-white/5 ring-1 ring-inset cursor-pointer
              transition-all duration-150 outline-none
              disabled:opacity-50 disabled:cursor-not-allowed
              ${error
                ? "ring-red-500/40 focus:ring-red-500/60"
                : "ring-white/10 focus:ring-white/22"
              }
              ${leading ? "pl-9" : ""}
              ${className}
            `}
            style={style}
            {...props}
          >
            {children}
          </select>

          <span className="absolute right-3 flex items-center text-white/30 pointer-events-none">
            <ChevronDown className="size-3.5" />
          </span>
        </div>

        {error && <p className="text-[11px] text-red-300/80">{error}</p>}
        {hint && !error && <p className="text-[11px] text-white/30">{hint}</p>}
      </div>
    );
  },
);
Select.displayName = "Select";
