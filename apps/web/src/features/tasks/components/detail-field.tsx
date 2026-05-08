"use client";

// Label-on-left field row used by both `task-detail` and `new-task-modal`.
// Width of the label column is fixed so controls align across rows.
// `align="start"` lets a multi-line value (e.g. tags chips) anchor the
// label at the top instead of vertically centering against a tall row.

import type { ReactNode } from "react";

export function DetailField({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div
      className={`flex gap-2 ${align === "start" ? "items-start" : "items-center"}`}
    >
      <span
        className={`text-xs text-white/40 w-16 shrink-0 ${align === "start" ? "pt-1.5" : ""}`}
      >
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
