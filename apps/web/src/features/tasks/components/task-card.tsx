"use client";

import type { TaskDTO } from "@occa/shared/types";
import { EFFORT_LABELS, TASK_TYPE_LABELS } from "../types";
import { isSystemTask } from "../utils";
import { MetaChip, PriorityDot } from "./form-controls";

// Kanban card. Layout is intentionally condensed (Linear-style):
//   header: #N · type · effort                         priority dot
//   title  (line-clamp-2)
//   meta   assignee · due
//   tags   (lowercase, capped at 3)
//
// Status pill is omitted because the column header already encodes
// status. Calendar icon is omitted because the date format is
// self-evident. System tasks substitute "⚙ SYSTEM" for the priority dot
// since their priority is meaningless to the user.
export function TaskCard({
  task,
  onClick,
}: {
  task: TaskDTO;
  onClick: (triggerRect: DOMRect) => void;
}) {
  const dueLabel = task.dueDate
    ? new Date(task.dueDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;

  const visibleTags = task.tags.slice(0, 3);
  const overflowTagCount = task.tags.length - visibleTags.length;
  const isArchived = task.archivedAt !== null;

  return (
    <button
      type="button"
      onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
      className={`w-full text-left glass-light rounded-xl p-3 space-y-2.5 hover:bg-white/8 transition-colors group ${isArchived ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <MetaChip mono>#{task.taskNumber}</MetaChip>
        {task.taskType !== "other" && (
          <MetaChip>{TASK_TYPE_LABELS[task.taskType]}</MetaChip>
        )}
        <MetaChip mono>{EFFORT_LABELS[task.effortLevel]}</MetaChip>
        <span className="ml-auto">
          {isArchived ? (
            <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/45 font-mono uppercase tracking-wide">
              Archived
            </span>
          ) : isSystemTask(task) ? (
            <MetaChip mono>⚙ SYSTEM</MetaChip>
          ) : (
            <PriorityDot priority={task.priority} />
          )}
        </span>
      </div>

      <p className="text-sm font-medium text-white/90 line-clamp-2 leading-snug">
        {task.title}
      </p>

      {(task.assignedAgentName || dueLabel) && (
        <div className="flex items-center gap-1.5 text-[11px] text-white/40">
          {task.assignedAgentName && <span>{task.assignedAgentName}</span>}
          {task.assignedAgentName && dueLabel && (
            <span className="text-white/20">·</span>
          )}
          {dueLabel && <span>{dueLabel}</span>}
        </div>
      )}

      {visibleTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className="text-[10px] text-white/35 lowercase"
            >
              {tag}
            </span>
          ))}
          {overflowTagCount > 0 && (
            <span className="text-[10px] text-white/25">
              +{overflowTagCount}
            </span>
          )}
        </div>
      )}

      {isArchived && task.archiveReason && (
        <p className="text-[10px] text-white/35 italic line-clamp-1">
          &ldquo;{task.archiveReason}&rdquo;
        </p>
      )}
    </button>
  );
}
