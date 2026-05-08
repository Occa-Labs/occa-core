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
