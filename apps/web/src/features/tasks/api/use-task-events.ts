"use client";

import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

// Polling cadence matches the list query — when the agent dispatcher
// emits new events, the timeline catches up within ~3s. Disabled when
// `enabled` is false (no task selected) so a closed detail panel stops
// polling.
const REFETCH_INTERVAL_MS = 3_000;

export function useTaskEvents(taskId: string | null) {
  return useQuery({
    queryKey: taskKeys.events(taskId ?? "none"),
    queryFn: async () => {
      if (!taskId) return [];
      const { events } = await tasksApi.events(taskId);
      return events;
    },
    enabled: !!taskId,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
}
