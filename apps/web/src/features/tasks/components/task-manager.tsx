"use client";

import { useCallback, useMemo, useState } from "react";
import { LayoutGrid, LayoutList } from "lucide-react";
import { AppWindow } from "@/components/ui/app-window";
import { useBoardData } from "@/features/tasks/api/use-board-data";
import { useDeleteTask } from "@/features/tasks/api/use-delete-task";
import { useTaskColumn } from "@/features/tasks/api/use-task-column";
import { useTaskCounts } from "@/features/tasks/api/use-task-counts";
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
//
// Data is paginated per column (board) or as one flat infinite list (list
// view), so the window never loads the full task table at once. Column
// totals come from the cheap counts aggregate, independent of how many
// cards have been paged in.
export function TaskManager({
  companyId,
  agentList,
  onClose,
}: TaskManagerProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");

  const hasCompany = Boolean(companyId);
  const board = useBoardData(hasCompany && view === "board", showArchived);
  const listQuery = useTaskColumn("all", hasCompany && view === "list", {
    includeArchived: showArchived,
  });
  const counts = useTaskCounts(hasCompany);

  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  // Cards in the active view — the superset the detail panel resolves
  // parent/child/selection against. Whatever isn't paged in yet simply
  // isn't found (parent/child chips hide gracefully).
  const listTasks = useMemo(
    () => listQuery.data?.pages.flatMap((p) => p.tasks) ?? [],
    [listQuery.data],
  );
  const loadedTasks = view === "board" ? board.allLoaded : listTasks;

  const taskNumberById = useMemo(
    () => new Map(loadedTasks.map((t) => [t.id, t.taskNumber])),
    [loadedTasks],
  );
  const parentNumberFor = useCallback(
    (task: TaskDTO): number | null =>
      task.parentTaskId ? taskNumberById.get(task.parentTaskId) ?? null : null,
    [taskNumberById],
  );

  // Totals for the subtitle — view-independent, straight from the aggregate.
  const activeCount = Object.values(counts.data?.counts ?? {}).reduce(
    (sum, n) => sum + n,
    0,
  );
  const archivedCount = counts.data?.archived ?? 0;

  const loading =
    hasCompany && (view === "board" ? board.isPending : listQuery.isPending);
  const queryError =
    view === "board"
      ? board.isError
        ? extractApiError(board.error)
        : null
      : listQuery.isError
        ? extractApiError(listQuery.error)
        : null;
  const mutationError =
    [updateTask, deleteTask]
      .map((m) => (m.isError ? extractApiError(m.error) : null))
      .find((e) => e !== null) ?? null;
  const error = queryError ?? mutationError;

  // Track selection by id so the detail panel auto-reflects polled
  // updates via a derived lookup, without a manual "sync selected on
  // tasks change".
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTriggerRect, setSelectedTriggerRect] =
    useState<DOMRect | null>(null);

  const selectedTask = selectedTaskId
    ? loadedTasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  const selectedParentTask = selectedTask?.parentTaskId
    ? loadedTasks.find((t) => t.id === selectedTask.parentTaskId) ?? null
    : null;
  const selectedChildTasks = selectedTask
    ? loadedTasks.filter((t) => t.parentTaskId === selectedTask.id)
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
              columns={board.columns}
              archived={board.archived}
              showArchivedColumn={showArchived}
              parentNumberFor={parentNumberFor}
              onTaskClick={openTaskDetail}
            />
          )}
          {!loading && !error && view === "list" && (
            <ListView
              tasks={listTasks}
              onTaskClick={openTaskDetail}
              hasNextPage={listQuery.hasNextPage}
              isFetchingNextPage={listQuery.isFetchingNextPage}
              onLoadMore={() => {
                if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
                  void listQuery.fetchNextPage();
                }
              }}
            />
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
