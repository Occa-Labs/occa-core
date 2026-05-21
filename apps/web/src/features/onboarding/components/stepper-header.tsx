"use client";

// Horizontal step indicator that sits inside the onboarding window's
// content area (NOT the AppWindow titlebar — AppWindow owns the chrome).
// Pure presentation; the parent owns the index + completed set.

import { Check } from "lucide-react";

export interface StepperHeaderProps {
  steps: { label: string }[];
  /** Zero-based index of the currently active step. */
  current: number;
  /** Zero-based indices of steps that have been completed (✓ instead of number). */
  completed: ReadonlySet<number>;
}

export function StepperHeader({ steps, current, completed }: StepperHeaderProps) {
  return (
    <ol className="flex items-center gap-3 px-1 pb-4 pt-1">
      {steps.map((s, i) => {
        const isDone = completed.has(i);
        const isCurrent = i === current && !isDone;
        return (
          <li
            key={s.label}
            className="flex flex-1 items-center gap-2 last:flex-initial"
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors ${
                isDone
                  ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-200"
                  : isCurrent
                    ? "border-sky-400/40 bg-sky-500/20 text-sky-100"
                    : "border-white/10 bg-white/5 text-white/45"
              }`}
            >
              {isDone ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span
              className={`whitespace-nowrap text-[12px] transition-colors ${
                isDone || isCurrent ? "text-white/85" : "text-white/40"
              }`}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span
                className={`ml-1 h-px flex-1 transition-colors ${
                  completed.has(i) ? "bg-emerald-400/40" : "bg-white/10"
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
