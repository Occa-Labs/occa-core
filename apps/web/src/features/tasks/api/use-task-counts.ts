"use client";

import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

// Cheap aggregate — keeps the column headers (and the window subtitle)
// accurate regardless of how many cards have been paged in. Polled so the
// totals stay live as the worker moves tasks between statuses.
const REFETCH_INTERVAL_MS = 4_000;

export function useTaskCounts(enabled: boolean) {
  return useQuery({
    queryKey: taskKeys.counts(),
    queryFn: () => tasksApi.counts(),
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
}
