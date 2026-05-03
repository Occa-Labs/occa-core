"use client";

import { Calendar } from "lucide-react";
import type { TaskDTO } from "@occa/shared/types";
import { isSystemTask, STATUS_COLUMNS } from "./_shared";
import {
  EFFORT_LABELS,
  PriorityBadge,
  TASK_TYPE_LABELS,
} from "./_form-controls";

export function TaskCard({
  task,
  onClick,
}: {
  task: TaskDTO;
  onClick: (triggerRect: DOMRect) => void;
}) {
  const statusCol = STATUS_COLUMNS.find((c) => c.id === task.status);
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
      className="w-full text-left glass-light rounded-xl p-3 space-y-2 hover:bg-white/8 transition-colors group"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono text-white/35 shrink-0">
          #{task.taskNumber}
        </span>
        <span
          className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${statusCol ? "bg-white/5 text-white/60" : "text-white/40"}`}
        >
          <span
            className={`size-1.5 rounded-full ${statusCol?.dot ?? "bg-white/30"}`}
          />
          {statusCol?.label ?? task.status}
        </span>
        {task.taskType !== "other" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/50">
            {TASK_TYPE_LABELS[task.taskType]}
          </span>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/50 font-mono">
          {EFFORT_LABELS[task.effortLevel]}
        </span>
      </div>
      <p className="text-xs font-medium text-white/90 line-clamp-2 leading-snug">
        {task.title}
      </p>
      <div className="flex items-center justify-between gap-2">
        {isSystemTask(task) ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/40 font-mono">
            ⚙ SYSTEM
          </span>
        ) : (
          <PriorityBadge priority={task.priority} />
        )}
        {task.assignedAgentName && (
          <span className="text-[10px] text-white/30 truncate">
            {task.assignedAgentName}
          </span>
        )}
      </div>
      {task.dueDate && (
        <div className="flex items-center gap-1 text-[10px] text-white/30">
          <Calendar className="size-3" />
          {new Date(task.dueDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </div>
      )}
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {task.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full glass-light px-1.5 py-0.5 text-[9px] text-white/40"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
