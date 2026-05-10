"use client";

import { CornerDownRight } from "lucide-react";
import type { TaskDTO } from "@occa/shared/types";
import { STATUS_COLUMNS } from "../types";
import { PriorityBadge } from "./form-controls";

export function ListView({
  tasks,
  onTaskClick,
}: {
  tasks: TaskDTO[];
  onTaskClick: (task: TaskDTO, triggerRect: DOMRect) => void;
}) {
  const taskNumberById = new Map(tasks.map((t) => [t.id, t.taskNumber]));
  return (
    <div className="overflow-y-auto h-full px-1">
      <table className="w-full text-xs border-separate border-spacing-y-1">
        <thead>
          <tr className="text-white/30 text-left">
            <th className="px-3 pb-2 font-medium">Title</th>
            <th className="px-3 pb-2 font-medium">Status</th>
            <th className="px-3 pb-2 font-medium">Priority</th>
            <th className="px-3 pb-2 font-medium">Assignee</th>
            <th className="px-3 pb-2 font-medium">Due</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const parentNumber = task.parentTaskId
              ? taskNumberById.get(task.parentTaskId) ?? null
              : null;
            return (
            <tr
              key={task.id}
              onClick={(e) =>
                onTaskClick(task, e.currentTarget.getBoundingClientRect())
              }
              className="glass-light rounded-xl cursor-pointer hover:bg-white/8 transition-colors"
            >
              <td className="px-3 py-2.5 rounded-l-xl font-medium text-white/80 max-w-48">
                <div className="flex items-center gap-1.5">
                  {parentNumber != null && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[10px] font-mono text-white/45 shrink-0"
                      title={`Child of task #${parentNumber}`}
                    >
                      <CornerDownRight className="size-2.5" />#{parentNumber}
                    </span>
                  )}
                  <span className="truncate">{task.title}</span>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-1.5">
                  <span
                    className={`size-1.5 rounded-full ${STATUS_COLUMNS.find((c) => c.id === task.status)?.dot ?? "bg-white/30"}`}
                  />
                  <span className="text-white/50 capitalize">
                    {STATUS_COLUMNS.find((c) => c.id === task.status)?.label ??
                      task.status}
                  </span>
                </span>
              </td>
              <td className="px-3 py-2.5">
                <PriorityBadge priority={task.priority} />
              </td>
              <td className="px-3 py-2.5 text-white/40">
                {task.assignedAgentName ?? "—"}
              </td>
              <td className="px-3 py-2.5 rounded-r-xl text-white/40">
                {task.dueDate
                  ? new Date(task.dueDate).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  : "—"}
              </td>
            </tr>
            );
          })}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-8 text-center text-white/20">
                No tasks yet. Click + New Task to get started.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
