"use client";

import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import type { ListTasksResponse, TaskDTO } from "@occa/shared/types";
import { useTaskColumn } from "./use-task-column";
import { useTaskCounts } from "./use-task-counts";

export interface BoardColumnData {
  /** Cards paged in so far (flattened across loaded pages). */
  tasks: TaskDTO[];
  /** True total from the counts aggregate — header shows this, not loaded count. */
  total: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
}

export interface BoardData {
  columns: {
    todo: BoardColumnData;
    in_progress: BoardColumnData;
    review: BoardColumnData;
    done: BoardColumnData;
  };
  archived: BoardColumnData;
  /** Union of every loaded card — feeds detail-panel parent/child lookups. */
  allLoaded: TaskDTO[];
  activeTotal: number;
  archivedTotal: number;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

type ColumnQuery = UseInfiniteQueryResult<
  { pages: ListTasksResponse[]; pageParams: unknown[] },
  unknown
>;

function toColumnData(query: ColumnQuery, total: number | undefined): BoardColumnData {
  const tasks = query.data?.pages.flatMap((p) => p.tasks) ?? [];
  return {
    tasks,
    total: total ?? tasks.length,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}

/**
 * Single entry point for the kanban board. Runs the counts aggregate plus one
 * infinite query per column, and exposes a presentational shape the board +
 * detail panel consume. The archived column only fetches when its view is on.
 */
export function useBoardData(enabled: boolean, includeArchived: boolean): BoardData {
  const counts = useTaskCounts(enabled);
  const todo = useTaskColumn("todo", enabled);
  const inProgress = useTaskColumn("in_progress", enabled);
  const review = useTaskColumn("review", enabled);
  const done = useTaskColumn("done", enabled);
  const archived = useTaskColumn("archived", enabled && includeArchived);

  const byStatus = counts.data?.counts ?? {};
  const columns = {
    todo: toColumnData(todo, byStatus.todo),
    in_progress: toColumnData(inProgress, byStatus.in_progress),
    review: toColumnData(review, byStatus.review),
    done: toColumnData(done, byStatus.done),
  };
  const archivedColumn = toColumnData(archived, counts.data?.archived);

  const allLoaded = [
    ...columns.todo.tasks,
    ...columns.in_progress.tasks,
    ...columns.review.tasks,
    ...columns.done.tasks,
    ...archivedColumn.tasks,
  ];

  // Active total counts every non-archived status (including `blocked`, which
  // has no column) so the subtitle matches reality, not just the 4 columns.
  const activeTotal = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

  const activeColumns = [todo, inProgress, review, done];
  const isPending =
    enabled && (counts.isPending || activeColumns.some((q) => q.isPending));
  const isError = counts.isError || activeColumns.some((q) => q.isError);
  const error =
    counts.error ?? activeColumns.find((q) => q.error)?.error ?? null;

  return {
    columns,
    archived: archivedColumn,
    allLoaded,
    activeTotal,
    archivedTotal: counts.data?.archived ?? 0,
    isPending,
    isError,
    error,
  };
}
