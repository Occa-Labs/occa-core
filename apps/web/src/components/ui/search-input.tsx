"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { Search } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Container className override. */
  containerClassName?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ containerClassName = "", className = "", style, ...props }, ref) => {
    return (
      <div
        className={`flex items-center gap-2 rounded-xl px-3 py-2 ring-1 ring-inset ring-white/10 focus-within:ring-white/22 transition-all ${containerClassName}`}
        style={{ background: "rgba(255,255,255,0.05)" }}
      >
        <Search className="size-3.5 text-white/30 shrink-0" />
        <input
          ref={ref}
          type="search"
          className={`flex-1 bg-transparent text-[13px] text-white/80 placeholder:text-white/25 outline-none min-w-0 ${className}`}
          style={style}
          {...props}
        />
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";
