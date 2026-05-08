"use client";

// Small reusable form controls + display primitives for the tasks
// feature. Form selects (StatusSelect / PrioritySelect / etc.) live
// alongside their read-only counterparts (PriorityBadge / PriorityDot /
// MetaChip) because they share the same `glass-light` styling family
// and the same source-of-truth tables in `../types.ts`.

import type { ReactNode } from "react";
import type {
  EffortLevel,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "@occa/shared/types";
import { EFFORT_LEVELS, TASK_TYPES } from "@occa/shared/types";
import {
  EFFORT_LABELS,
  PRIORITY_CONFIG,
  STATUS_COLUMNS,
  TASK_TYPE_LABELS,
} from "../types";

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const cfg = PRIORITY_CONFIG[priority];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cfg.color}`}
    >
      {cfg.label}
    </span>
  );
}

// Compact priority signal for the kanban card — just a colored dot. The
// label is dropped because the dot color already encodes the level
// (white→blue→amber→red) and the card real-estate is too tight for a
// label badge alongside the title.
export function PriorityDot({ priority }: { priority: TaskPriority }) {
  const cfg = PRIORITY_CONFIG[priority];
  return (
    <span
      className={`inline-block size-2 rounded-full ${cfg.dot}`}
      title={`${cfg.label} priority`}
    />
  );
}

// Generic small pill used for task metadata on the card (type, effort,
// task number). Single source of truth for the chip geometry so cards
// look consistent without duplicating the className across siblings.
export function MetaChip({
  children,
  mono,
}: {
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 ${mono ? "font-mono" : ""}`}
    >
      {children}
    </span>
  );
}

export function StatusSelect({
  value,
  onChange,
}: {
  value: TaskStatus;
  onChange: (v: TaskStatus) => void;
}) {
  const col = STATUS_COLUMNS.find((c) => c.id === value);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TaskStatus)}
        className="appearance-none glass-light rounded-lg px-3 py-1.5 text-xs text-white/80 cursor-pointer pr-7 focus:outline-none focus:ring-1 focus:ring-white/20"
      >
        {STATUS_COLUMNS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        <span className={`size-1.5 rounded-full ${col?.dot ?? "bg-white/30"}`} />
      </div>
    </div>
  );
}

export function PrioritySelect({
  value,
  onChange,
}: {
  value: TaskPriority;
  onChange: (v: TaskPriority) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as TaskPriority)}
      className="appearance-none glass-light rounded-lg px-3 py-1.5 text-xs text-white/80 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
    >
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
      <option value="urgent">Urgent</option>
    </select>
  );
}

export function TaskTypeSelect({
  value,
  onChange,
}: {
  value: TaskType;
  onChange: (v: TaskType) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as TaskType)}
      className="appearance-none glass-light rounded-lg px-3 py-1.5 text-xs text-white/80 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
    >
      {TASK_TYPES.map((t) => (
        <option key={t} value={t}>
          {TASK_TYPE_LABELS[t]}
        </option>
      ))}
    </select>
  );
}

export function EffortSelect({
  value,
  onChange,
}: {
  value: EffortLevel;
  onChange: (v: EffortLevel) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as EffortLevel)}
      className="appearance-none glass-light rounded-lg px-3 py-1.5 text-xs text-white/80 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white/20"
    >
      {EFFORT_LEVELS.map((l) => (
        <option key={l} value={l}>
          {EFFORT_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
