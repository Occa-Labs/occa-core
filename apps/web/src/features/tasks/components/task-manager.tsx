"use client";

import { useCallback, useState } from "react";
import { LayoutGrid, LayoutList, Plus } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { useCreateTask } from "@/features/tasks/api/use-create-task";
import { useDeleteTask } from "@/features/tasks/api/use-delete-task";
import { useTasksList } from "@/features/tasks/api/use-tasks-list";
import { useUpdateTask } from "@/features/tasks/api/use-update-task";
import { ApiError } from "@/lib/api";
import type {
  TaskDTO,
  TaskStatus,
  UpdateTaskRequest,
} from "@occa/shared/types";
import { BoardView } from "./board-view";
import { ListView } from "./list-view";
import { TaskDetail } from "./task-detail";
import { NewTaskModal, type NewTaskFormData } from "./new-task-modal";

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
// the detail / new-task panels. Each rendered surface is its own file
// under features/tasks/components/. State machine here is small: which
// view, which task is open in the detail panel, and whether the new-task
// dialog is mounted.
export function TaskManager({
  companyId,
  agentList,
  onClose,
}: TaskManagerProps) {
  const [showArchived, setShowArchived] = useState(false);
  const tasksQuery = useTasksList(Boolean(companyId), {
    includeArchived: showArchived,
  });
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const tasks = tasksQuery.data ?? [];
  const archivedCount = tasks.filter((t) => t.archivedAt !== null).length;
  const activeCount = tasks.length - archivedCount;
  const loading = tasksQuery.isPending && Boolean(companyId);
  const queryError = tasksQuery.isError ? extractApiError(tasksQuery.error) : null;
  const mutationError =
    [createTask, updateTask, deleteTask]
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
  const [newTaskState, setNewTaskState] = useState<{
    status: TaskStatus;
    triggerRect: DOMRect;
  } | null>(null);

  const selectedTask = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

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

  const handleCreateTask = useCallback(
    async (data: NewTaskFormData) => {
      const blocks = data.description
        ? [{ type: "paragraph" as const, text: data.description }]
        : undefined;
      const dueDateIso = data.dueDate
        ? new Date(`${data.dueDate}T23:59:59`).toISOString()
        : null;
      try {
        const task = await createTask.mutateAsync({
          title: data.title,
          status: data.status,
          priority: data.priority,
          taskType: data.taskType,
          effortLevel: data.effortLevel,
          assignedAgentId: data.assignedAgentId ?? null,
          blocks,
          tags: data.tags.length > 0 ? data.tags : undefined,
          dueDate: dueDateIso,
        });
        setNewTaskState(null);
        // No trigger for the post-create open — FloatingPanel falls back
        // to its default viewport-centered position.
        openTaskDetail(task, null);
      } catch {
        // Error surfaces through createTask.error → mutationError above.
      }
    },
    [createTask, openTaskDetail],
  );

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
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) =>
          setNewTaskState({
            status: "todo",
            triggerRect: e.currentTarget.getBoundingClientRect(),
          })
        }
        className="flex items-center gap-1.5 glass-light rounded-lg px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/10 hover:text-white transition-colors"
      >
        <Plus className="size-3.5" />
        New Task
      </button>
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
              onCreateTask={(status, rect) =>
                setNewTaskState({ status, triggerRect: rect })
              }
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
          triggerRect={selectedTriggerRect}
          agentList={agentList}
          onUpdate={handleUpdateTask}
          onDelete={handleDeleteTask}
          onClose={closeTaskDetail}
        />
      )}

      {newTaskState !== null && (
        <NewTaskModal
          defaultStatus={newTaskState.status}
          triggerRect={newTaskState.triggerRect}
          agentList={agentList}
          onConfirm={handleCreateTask}
          onCancel={() => setNewTaskState(null)}
        />
      )}
    </>
  );
}
