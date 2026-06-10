"use client";

import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

// Per-task token/cost summary. Polls on the same cadence as the event
// timeline so the cost ticks up as re-dispatches finish, then settles once
// the task is done. Disabled when no task is selected.
const REFETCH_INTERVAL_MS = 3_000;

export function useTaskUsage(taskId: string | null) {
  return useQuery({
    queryKey: taskKeys.usage(taskId ?? "none"),
    queryFn: () => tasksApi.usage(taskId!),
    enabled: !!taskId,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
}
