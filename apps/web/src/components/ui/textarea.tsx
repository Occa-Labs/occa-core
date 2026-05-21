"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    { label, hint, error, className = "", style, id, rows = 4, ...props },
    ref,
  ) => {
    const areaId =
      id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={areaId}
            className="text-[11px] text-white/50 font-medium"
          >
            {label}
          </label>
        )}

        <textarea
          ref={ref}
          id={areaId}
          rows={rows}
          className={`
            w-full rounded-xl px-3.5 py-2.5 text-[13px] text-white/85
            leading-relaxed placeholder:text-white/22 resize-y
            bg-white/5 ring-1 ring-inset
            transition-all duration-150 outline-none
            disabled:opacity-50 disabled:cursor-not-allowed
            ${
              error
                ? "ring-red-500/40 focus:ring-red-500/60"
                : "ring-white/10 focus:ring-white/22"
            }
            ${className}
          `}
          style={style}
          {...props}
        />

        {error && <p className="text-[11px] text-red-300/80">{error}</p>}
        {hint && !error && <p className="text-[11px] text-white/30">{hint}</p>}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
