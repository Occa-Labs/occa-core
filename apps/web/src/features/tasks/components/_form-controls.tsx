"use client";

// Small reusable form controls used by NewTaskModal + TaskDetail. They
// share the glass-light styling and thin-pill geometry; extracting them
// keeps the parent files focused on layout instead of input chrome.

import type {
  EffortLevel,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "@occa/shared/types";
import { EFFORT_LEVELS, TASK_TYPES } from "@occa/shared/types";
import { PRIORITY_CONFIG, STATUS_COLUMNS } from "./_shared";

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

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  feature: "Feature",
  bug: "Bug",
  research: "Research",
  docs: "Docs",
  chore: "Chore",
  other: "Other",
};

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

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};

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
