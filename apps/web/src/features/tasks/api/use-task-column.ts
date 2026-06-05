"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { TaskStatus } from "@occa/shared/types";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

// Server caps a page at 50 regardless; keep the client request aligned so
// `offset = loadedPages * PAGE_SIZE` stays correct.
const PAGE_SIZE = 50;
const REFETCH_INTERVAL_MS = 4_000;

/**
 * A paginated board column. Either a single status, the archived view, or
 * "all" (the flat list view, active rows — pass `includeArchived` to mix in
 * shelved rows). Each column paginates independently via offset, so the giant
 * Done column never loads more than the pages actually scrolled into view.
 *
 * Note: `refetchInterval` refetches every loaded page. In practice only the
 * first page of each column is loaded unless the user scrolls deep, so the
 * poll cost stays bounded — a fraction of the old "fetch every task" model.
 */
export type ColumnKey = TaskStatus | "archived" | "all";

export function useTaskColumn(
  column: ColumnKey,
  enabled: boolean,
  opts: { includeArchived?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: taskKeys.column(column, opts),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      tasksApi.list({
        ...columnParams(column, opts),
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length * PAGE_SIZE : undefined,
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
}

function columnParams(
  column: ColumnKey,
  opts: { includeArchived?: boolean },
): { status?: TaskStatus; archivedOnly?: boolean; includeArchived?: boolean } {
  if (column === "archived") return { archivedOnly: true };
  if (column === "all") return { includeArchived: opts.includeArchived };
  return { status: column };
}
