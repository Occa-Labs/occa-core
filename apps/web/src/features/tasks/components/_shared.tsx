"use client";

// Shared helpers + constants for the task-manager sub-components. Pure
// values — no React hooks here. Constants like STATUS_COLUMNS and
// BLOCK_TYPES include lucide icons (JSX), so this file has to be .tsx
// rather than .ts.

import type { ReactNode } from "react";
import {
  AlignLeft,
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  Minus,
  Quote,
} from "lucide-react";
import type {
  ContentBlock,
  TaskDTO,
  TaskPriority,
  TaskStatus,
} from "@occa/shared/types";

export const isSystemTask = (task: TaskDTO) =>
  task.tags?.includes("system") ?? false;

export const STATUS_COLUMNS: { id: TaskStatus; label: string; dot: string }[] = [
  { id: "todo", label: "To Do", dot: "bg-white/30" },
  { id: "in_progress", label: "In Progress", dot: "bg-blue-400" },
  { id: "review", label: "Review", dot: "bg-amber-400" },
  { id: "done", label: "Done", dot: "bg-green-400" },
];

export const PRIORITY_CONFIG: Record<
  TaskPriority,
  { label: string; color: string }
> = {
  low: { label: "Low", color: "text-white/40 bg-white/5" },
  medium: { label: "Medium", color: "text-blue-300 bg-blue-500/10" },
  high: { label: "High", color: "text-amber-300 bg-amber-500/10" },
  urgent: { label: "Urgent", color: "text-red-300 bg-red-500/10" },
};

export const BLOCK_TYPES: {
  type: ContentBlock["type"];
  label: string;
  icon: ReactNode;
}[] = [
  { type: "paragraph", label: "Text", icon: <AlignLeft className="size-3.5" /> },
  {
    type: "heading_1",
    label: "Heading 1",
    icon: <Heading1 className="size-3.5" />,
  },
  {
    type: "heading_2",
    label: "Heading 2",
    icon: <Heading2 className="size-3.5" />,
  },
  {
    type: "heading_3",
    label: "Heading 3",
    icon: <Heading3 className="size-3.5" />,
  },
  { type: "bullet", label: "Bullet List", icon: <List className="size-3.5" /> },
  {
    type: "checklist",
    label: "Checklist",
    icon: <CheckSquare className="size-3.5" />,
  },
  { type: "quote", label: "Quote", icon: <Quote className="size-3.5" /> },
  { type: "code", label: "Code", icon: <Code className="size-3.5" /> },
  { type: "divider", label: "Divider", icon: <Minus className="size-3.5" /> },
];

export function makeBlock(type: ContentBlock["type"]): ContentBlock {
  if (type === "divider") return { type: "divider" };
  if (type === "checklist")
    return { type: "checklist", text: "", checked: false };
  // agent_result is worker-authored; users can't create it via the slash
  // menu. Fall through to a paragraph if something triggers this path anyway.
  if (type === "agent_result") return { type: "paragraph", text: "" };
  return { type, text: "" } as ContentBlock;
}

export function blockText(block: ContentBlock): string {
  if (block.type === "divider") return "";
  if (block.type === "agent_result") return block.preview;
  return block.text ?? "";
}

export function formatResultTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
