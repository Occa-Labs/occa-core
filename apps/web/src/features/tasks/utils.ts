// Pure helpers for the tasks feature. No React, no JSX.

import type { ContentBlock, TaskDTO } from "@occa/shared/types";

export const isSystemTask = (task: TaskDTO) =>
  task.tags?.includes("system") ?? false;

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

// Compact created-at label for task rows/cards: today shows the clock time
// (items minted minutes apart stay distinguishable), older shows the short
// date. Mirrors formatCommentTime's same-day rule.
export function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Full created-at label for the detail panel: date + 24-hour time with
// seconds (no AM/PM). e.g. "05 Jun 2026, 15:00:18".
export function formatCreatedFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
