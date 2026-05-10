"use client";

import { Archive } from "lucide-react";
import type { TaskDTO, TaskStatus } from "@occa/shared/types";
import { STATUS_COLUMNS } from "../types";
import { TaskCard } from "./task-card";

// Read-only kanban board: task creation is gone (CEO chat bubble owns the
// entry). Cards stay clickable for detail view + drag-to-status updates.
export function BoardView({
  tasks,
  showArchivedColumn,
  onTaskClick,
}: {
  tasks: TaskDTO[];
  showArchivedColumn?: boolean;
  onTaskClick: (task: TaskDTO, triggerRect: DOMRect) => void;
}) {
  // Active columns ignore archived rows — that's what makes the
  // 5th "Archived" column meaningful (no double-counting).
  const activeTasks = tasks.filter((t) => t.archivedAt === null);
  const archivedTasks = tasks.filter((t) => t.archivedAt !== null);
  const columns = STATUS_COLUMNS;
  const tasksByStatus = (status: TaskStatus) =>
    activeTasks.filter((t) => t.status === status);

  // id → taskNumber lookup so child cards can render a `↳ #parent` chip
  // without an extra fetch. Parent might be archived/missing — fallback
  // to null and the chip just hides.
  const taskNumberById = new Map(tasks.map((t) => [t.id, t.taskNumber]));
  const parentNumberFor = (t: TaskDTO): number | null =>
    t.parentTaskId ? taskNumberById.get(t.parentTaskId) ?? null : null;

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
            </div>

            <div className="flex flex-col gap-2 overflow-y-auto flex-1">
              {colTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  parentTaskNumber={parentNumberFor(task)}
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

      {showArchivedColumn && (
        <div
          className="shrink-0 w-64 flex flex-col gap-2 rounded-xl p-3"
          style={{ background: "rgba(255,255,255,0.04)" }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Archive className="size-3 text-white/40" />
              <span className="text-xs font-medium text-white/70">
                Archived
              </span>
              <span className="text-[10px] text-white/30">
                {archivedTasks.length}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2 overflow-y-auto flex-1">
            {archivedTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={(rect) => onTaskClick(task, rect)}
              />
            ))}
            {archivedTasks.length === 0 && (
              <div className="flex items-center justify-center py-6 text-[10px] text-white/20">
                No archived tasks
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
