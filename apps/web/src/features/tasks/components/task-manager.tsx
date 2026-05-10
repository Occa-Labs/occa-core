"use client";

import { useCallback, useState } from "react";
import { LayoutGrid, LayoutList } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { useDeleteTask } from "@/features/tasks/api/use-delete-task";
import { useTasksList } from "@/features/tasks/api/use-tasks-list";
import { useUpdateTask } from "@/features/tasks/api/use-update-task";
import { ApiError } from "@/lib/api";
import type { TaskDTO, UpdateTaskRequest } from "@occa/shared/types";
import { BoardView } from "./board-view";
import { ListView } from "./list-view";
import { TaskDetail } from "./task-detail";

function extractApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (
      err.body &&
      typeof err.body === "object" &&
      "error" in err.body &&
      typeof (err.body as Record<string, unknown>).error === "string"
    ) {
      return (err.body as { error: string }).error;
    }
    return `api_${err.status}`;
  }
  return err instanceof Error ? err.message : "failed";
}

interface TaskManagerProps {
  companyId: string;
  agentList?: { id: string; name: string; role: string }[];
  onClose?: () => void;
}

// Top-level task management window. Composes the kanban / list views and
// the detail panel. Read + edit only — task creation moved to the CEO
// chat bubble in `shell/ceo-chat-bubble.tsx` per the hierarchical agent
// system entry-lock (design doc §2: user only talks to CEO).
export function TaskManager({
  companyId,
  agentList,
  onClose,
}: TaskManagerProps) {
  const [showArchived, setShowArchived] = useState(false);
  const tasksQuery = useTasksList(Boolean(companyId), {
    includeArchived: showArchived,
  });
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const tasks = tasksQuery.data ?? [];
  const archivedCount = tasks.filter((t) => t.archivedAt !== null).length;
  const activeCount = tasks.length - archivedCount;
  const loading = tasksQuery.isPending && Boolean(companyId);
  const queryError = tasksQuery.isError ? extractApiError(tasksQuery.error) : null;
  const mutationError =
    [updateTask, deleteTask]
      .map((m) => (m.isError ? extractApiError(m.error) : null))
      .find((e) => e !== null) ?? null;
  const error = queryError ?? mutationError;

  const [view, setView] = useState<"board" | "list">("board");
  // Track selection by id so the detail panel auto-reflects polled
  // updates via a derived lookup, without a manual "sync selected on
  // tasks change".
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTriggerRect, setSelectedTriggerRect] =
    useState<DOMRect | null>(null);

  const selectedTask = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  const selectedParentTask = selectedTask?.parentTaskId
    ? tasks.find((t) => t.id === selectedTask.parentTaskId) ?? null
    : null;
  const selectedChildTasks = selectedTask
    ? tasks.filter((t) => t.parentTaskId === selectedTask.id)
    : [];

  const openTaskDetail = useCallback(
    (task: TaskDTO, triggerRect: DOMRect | null) => {
      setSelectedTaskId(task.id);
      setSelectedTriggerRect(triggerRect);
    },
    [],
  );

  const closeTaskDetail = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedTriggerRect(null);
  }, []);

  const handleUpdateTask = useCallback(
    (updates: UpdateTaskRequest) => {
      if (!selectedTaskId) return;
      updateTask.mutate({ id: selectedTaskId, patch: updates });
    },
    [selectedTaskId, updateTask],
  );

  const handleDeleteTask = useCallback(() => {
    if (!selectedTaskId) return;
    deleteTask.mutate(selectedTaskId);
    closeTaskDetail();
  }, [selectedTaskId, deleteTask, closeTaskDetail]);

  const headerRight = (
    <div className="flex items-center gap-2">
      <label
        className="flex items-center gap-1.5 text-[11px] text-white/50 hover:text-white/70 cursor-pointer select-none"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          className="size-3 accent-white/40"
        />
        Show archived
      </label>
      <div className="flex glass-light rounded-lg p-0.5 gap-0.5">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setView("board")}
          className={`p-1.5 rounded-md transition-colors ${view === "board" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}
        >
          <LayoutGrid className="size-3.5" />
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setView("list")}
          className={`p-1.5 rounded-md transition-colors ${view === "list" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}
        >
          <LayoutList className="size-3.5" />
        </button>
      </div>
    </div>
  );

  return (
    <>
      <AppWindow
        title="Task Board"
        subtitle={
          showArchived && archivedCount > 0
            ? `${activeCount} active · ${archivedCount} archived`
            : `${activeCount} task${activeCount !== 1 ? "s" : ""}`
        }
        onClose={onClose}
        headerRight={headerRight}
        defaultSize={{
          w: Math.round(window.innerWidth * 0.8),
          h: Math.round(window.innerHeight * 0.8),
        }}
        minWidth={600}
        minHeight={Math.round(window.innerHeight * 0.8)}
      >
        <div className="h-full overflow-hidden p-3">
          {loading && (
            <div className="flex items-center justify-center h-full text-sm text-white/30">
              Loading tasks…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-sm text-red-400">
              {error}
            </div>
          )}
          {!loading && !error && view === "board" && (
            <BoardView
              tasks={tasks}
              showArchivedColumn={showArchived}
              onTaskClick={openTaskDetail}
            />
          )}
          {!loading && !error && view === "list" && (
            <ListView tasks={tasks} onTaskClick={openTaskDetail} />
          )}
        </div>
      </AppWindow>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          parentTask={selectedParentTask}
          childTasks={selectedChildTasks}
          triggerRect={selectedTriggerRect}
          agentList={agentList}
          onUpdate={handleUpdateTask}
          onDelete={handleDeleteTask}
          onClose={closeTaskDetail}
          onNavigateToTask={(t) => openTaskDetail(t, null)}
        />
      )}
    </>
  );
}
