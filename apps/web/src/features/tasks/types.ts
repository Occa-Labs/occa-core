// Pure UI constants for the tasks feature. No JSX.

import type {
  EffortLevel,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "@occa/shared/types";

// Real task statuses a user can pick from the status dropdown + the labels
// list-view resolves against. Excludes pseudo / system states.
export const STATUS_COLUMNS: { id: TaskStatus; label: string; dot: string }[] = [
  { id: "todo", label: "To Do", dot: "bg-white/30" },
  { id: "in_progress", label: "In Progress", dot: "bg-blue-400" },
  { id: "review", label: "Review", dot: "bg-amber-400" },
  { id: "done", label: "Done", dot: "bg-green-400" },
];

// Kanban board columns. "attention" is a pseudo-column grouping `blocked`
// + `error` (tasks the operator must act on) — distinct from STATUS_COLUMNS
// so it never leaks into the status dropdown. Keyed to BoardData["columns"].
export type BoardColumnKey =
  | "todo"
  | "in_progress"
  | "attention"
  | "review"
  | "done";

export const BOARD_COLUMNS: {
  id: BoardColumnKey;
  label: string;
  dot: string;
}[] = [
  { id: "todo", label: "To Do", dot: "bg-white/30" },
  { id: "in_progress", label: "In Progress", dot: "bg-blue-400" },
  { id: "review", label: "Review", dot: "bg-amber-400" },
  { id: "done", label: "Done", dot: "bg-green-400" },
  { id: "attention", label: "Needs attention", dot: "bg-red-400" },
];

// `color` = badge background+text (PriorityBadge). `dot` = solid dot
// background (PriorityDot — used on the kanban card where label text
// would crowd the layout).
export const PRIORITY_CONFIG: Record<
  TaskPriority,
  { label: string; color: string; dot: string }
> = {
  low: { label: "Low", color: "text-white/40 bg-white/5", dot: "bg-white/30" },
  medium: {
    label: "Medium",
    color: "text-blue-300 bg-blue-500/10",
    dot: "bg-blue-400",
  },
  high: {
    label: "High",
    color: "text-amber-300 bg-amber-500/10",
    dot: "bg-amber-400",
  },
  urgent: {
    label: "Urgent",
    color: "text-red-300 bg-red-500/10",
    dot: "bg-red-400",
  },
};

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  feature: "Feature",
  bug: "Bug",
  research: "Research",
  docs: "Docs",
  chore: "Chore",
  other: "Other",
};

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  xs: "XS",
  s: "S",
  m: "M",
  l: "L",
  xl: "XL",
};
