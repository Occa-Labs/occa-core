"use client";

import { type ReactNode, useState } from "react";
import { Archive, MoreVertical, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Dropdown } from "@/components/ui/dropdown";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import type { TaskDTO } from "@occa/shared/types";
import type { BoardColumnData, BoardData } from "../api/use-board-data";
import { useBulkTaskAction } from "../api/use-bulk-task-action";
import { useInView } from "@/lib/use-in-view";
import { BOARD_COLUMNS, type BoardColumnKey } from "../types";
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
          columnId={col.id}
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
  columnId,
  label,
  dot,
  data,
  parentNumberFor,
  onTaskClick,
  emptyLabel = "No tasks",
}: {
  columnId?: BoardColumnKey;
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
        {columnId === "attention" && data.total > 0 && (
          <ColumnActionsMenu
            statusFilter="attention"
            total={data.total}
            className="ml-auto"
          />
        )}
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

// Per-column 3-dot menu. Currently only the "Needs attention" column mounts
// it (see BoardColumn). "Archive all" is reversible so it fires directly;
// "Delete all" is a hard remove, so it routes through a confirm modal.
// `statusFilter` is the server-side column key ("attention" = blocked + error).
function ColumnActionsMenu({
  statusFilter,
  total,
  className = "",
}: {
  statusFilter: string;
  total: number;
  className?: string;
}) {
  const bulk = useBulkTaskAction();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runArchive = () => {
    bulk.mutate({ action: "archive", status: statusFilter });
  };
  const runDelete = () => {
    bulk.mutate(
      { action: "delete", status: statusFilter },
      { onSettled: () => setConfirmOpen(false) },
    );
  };

  return (
    <div className={className}>
      <Dropdown
        align="right"
        trigger={
          <button
            type="button"
            aria-label="Column actions"
            className="flex size-5 cursor-pointer items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
          >
            <MoreVertical className="size-3.5" />
          </button>
        }
        items={[
          {
            key: "archive-all",
            label: "Archive all",
            icon: <Archive className="size-3.5" />,
            onClick: runArchive,
          },
          {
            key: "delete-all",
            label: "Delete all",
            icon: <Trash2 className="size-3.5" />,
            variant: "danger",
            dividerBefore: true,
            onClick: () => setConfirmOpen(true),
          },
        ]}
      />

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Delete all tasks?"
        width="min(420px, 92vw)"
        footer={
          <div className="flex justify-end gap-2 px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={bulk.isPending}
              onClick={runDelete}
            >
              {bulk.isPending ? "Deleting…" : `Delete ${total}`}
            </Button>
          </div>
        }
      >
        <div className="px-4 py-4 text-[13px] leading-relaxed text-white/70">
          This permanently deletes{" "}
          <span className="font-semibold text-white/90">{total}</span>{" "}
          {total === 1 ? "task" : "tasks"} in this column. This can&apos;t be
          undone.
        </div>
      </Modal>
    </div>
  );
}
