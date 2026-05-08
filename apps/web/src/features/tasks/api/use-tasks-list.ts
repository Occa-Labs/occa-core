"use client";

import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

// 3s — the worker dispatcher updates task status in the background
// (in_progress → done). Without polling the UI would show stale state
// until the user touches a mutation. SSE will eventually replace this.
const REFETCH_INTERVAL_MS = 3_000;

export function useTasksList(
  enabled: boolean,
  opts: { includeArchived?: boolean } = {},
) {
  const includeArchived = opts.includeArchived ?? false;
  return useQuery({
    queryKey: taskKeys.list({ includeArchived }),
    queryFn: async () => {
      const { tasks } = await tasksApi.list({ includeArchived });
      return tasks;
    },
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
}
