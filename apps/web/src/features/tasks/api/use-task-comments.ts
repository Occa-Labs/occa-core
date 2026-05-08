"use client";

import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "@/lib/api";
import { taskKeys } from "./keys";

// Comments poll on the same 3s cadence as tasks/events so an agent reply
// (woken via @mention) shows up close to real-time without SSE.
const REFETCH_INTERVAL_MS = 3_000;

export function useTaskComments(taskId: string | null) {
  return useQuery({
    queryKey: taskKeys.comments(taskId ?? "none"),
    queryFn: async () => {
      if (!taskId) return [];
      const { comments } = await tasksApi.comments(taskId);
      return comments;
    },
    enabled: !!taskId,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false,
  });
}
