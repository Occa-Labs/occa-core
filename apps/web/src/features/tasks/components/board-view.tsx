"use client";

import { Plus } from "lucide-react";
import type { TaskDTO, TaskStatus } from "@occa/shared/types";
import { STATUS_COLUMNS } from "./_shared";
import { TaskCard } from "./task-card";

export function BoardView({
  tasks,
  onTaskClick,
  onCreateTask,
}: {
  tasks: TaskDTO[];
  onTaskClick: (task: TaskDTO, triggerRect: DOMRect) => void;
  onCreateTask: (status: TaskStatus, triggerRect: DOMRect) => void;
}) {
  const columns = STATUS_COLUMNS;
  const tasksByStatus = (status: TaskStatus) =>
    tasks.filter((t) => t.status === status);

  return (
    <div className="flex gap-3 h-full overflow-x-auto pb-2 px-1">
      {columns.map((col) => {
        const colTasks = tasksByStatus(col.id);
        return (
          <div
            key={col.id}
            className="shrink-0 w-64 flex flex-col gap-2 rounded-xl p-3"
            style={{ background: "rgba(255,255,255,0.04)" }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${col.dot}`} />
                <span className="text-xs font-medium text-white/70">
                  {col.label}
                </span>
                <span className="text-[10px] text-white/30">
                  {colTasks.length}
                </span>
              </div>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) =>
                  onCreateTask(col.id, e.currentTarget.getBoundingClientRect())
                }
                className="p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white/70 transition-colors"
              >
                <Plus className="size-3.5" />
              </button>
            </div>

            <div className="flex flex-col gap-2 overflow-y-auto flex-1">
              {colTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={(rect) => onTaskClick(task, rect)}
                />
              ))}
              {colTasks.length === 0 && (
                <div className="flex items-center justify-center py-6 text-[10px] text-white/20">
                  No tasks
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
