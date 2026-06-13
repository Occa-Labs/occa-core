"use client";

import type { ReactNode } from "react";
import { Archive } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { TaskDTO } from "@occa/shared/types";
import type { BoardColumnData, BoardData } from "../api/use-board-data";
import { useInView } from "@/lib/use-in-view";
import { BOARD_COLUMNS } from "../types";
import { TaskCard } from "./task-card";

// Read-only kanban board. Each column is an independently paginated infinite
// query (see useBoardData) — only the first page loads up front; scrolling a
// column to the bottom pulls the next page. Headers show the true total from
// the counts aggregate, not just how many cards are loaded.
export function BoardView({
  columns,
  archived,
  showArchivedColumn,
  parentNumberFor,
  onTaskClick,
}: {
  columns: BoardData["columns"];
  archived: BoardColumnData;
  showArchivedColumn?: boolean;
  parentNumberFor: (task: TaskDTO) => number | null;
  onTaskClick: (task: TaskDTO, triggerRect: DOMRect) => void;
}) {
  return (
    <div className="flex gap-3 h-full overflow-x-auto pb-2 px-1">
      {BOARD_COLUMNS.map((col) => (
        <BoardColumn
          key={col.id}
          label={col.label}
          dot={<span className={`size-2 rounded-full ${col.dot}`} />}
          data={columns[col.id]}
          parentNumberFor={parentNumberFor}
          onTaskClick={onTaskClick}
        />
      ))}

      {showArchivedColumn && (
        <BoardColumn
          label="Archived"
          dot={<Archive className="size-3 text-white/40" />}
          data={archived}
          parentNumberFor={parentNumberFor}
          onTaskClick={onTaskClick}
          emptyLabel="No archived tasks"
        />
      )}
    </div>
  );
}

function BoardColumn({
  label,
  dot,
  data,
  parentNumberFor,
  onTaskClick,
  emptyLabel = "No tasks",
}: {
  label: string;
  dot: ReactNode;
  data: BoardColumnData;
  parentNumberFor: (task: TaskDTO) => number | null;
  onTaskClick: (task: TaskDTO, triggerRect: DOMRect) => void;
  emptyLabel?: string;
}) {
  const sentinelRef = useInView(data.loadMore, data.hasNextPage);

  return (
    <div
      className="shrink-0 w-64 flex flex-col gap-2 rounded-xl p-3"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      <div className="flex items-center gap-2">
        {dot}
        <span className="text-xs font-medium text-white/70">{label}</span>
        <span className="text-[10px] text-white/30">{data.total}</span>
      </div>

      <div className="flex flex-col gap-2 overflow-y-auto flex-1">
        {data.tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            parentTaskNumber={parentNumberFor(task)}
            onClick={(rect) => onTaskClick(task, rect)}
          />
        ))}

        {data.tasks.length === 0 && (
          <div className="flex items-center justify-center py-6 text-[10px] text-white/20">
            {emptyLabel}
          </div>
        )}

        {data.hasNextPage && <div ref={sentinelRef} className="h-px" />}

        {data.isFetchingNextPage && (
          <div className="flex items-center justify-center py-3">
            <Spinner variant="block" className="text-base text-white/40" />
          </div>
        )}
      </div>
    </div>
  );
}
